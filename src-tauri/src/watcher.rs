use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DEBOUNCE_MS: u64 = 300;

pub struct WatcherState {
    pub handle: Mutex<Option<RecommendedWatcher>>,
    /// canonical path string → canonical PathBuf for all opened files
    pub files: Mutex<HashMap<String, PathBuf>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
            files: Mutex::new(HashMap::new()),
        }
    }
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Compute display name from a file path using a snapshot of watched files.
/// If another file with the same filename exists, prefix with parent directory.
pub(crate) fn display_name_from_snapshot(
    path: &std::path::Path,
    files: &HashMap<String, PathBuf>,
) -> String {
    let filename = crate::commands::filename_from_path(path);
    let has_conflict = files.values().any(|existing| {
        crate::commands::filename_from_path(existing) == filename && existing != path
    });
    if has_conflict {
        if let Some(parent) = path.parent().and_then(|p| p.file_name()) {
            return format!("{}/{}", parent.to_string_lossy(), filename);
        }
    }
    filename
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Returns true if the event kind is one we should process (Modify or Create).
pub(crate) fn is_relevant_event(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Modify(_) | EventKind::Create(_))
}

/// Returns true if enough time has passed since last_ms (debounce check).
pub(crate) fn should_emit(now_ms: u64, last_ms: u64, debounce_ms: u64) -> bool {
    now_ms.saturating_sub(last_ms) >= debounce_ms
}

/// Match each path in a single notify event against the watched set and return
/// the canonical watched keys to consider reloading — deduped (a path delivered
/// twice in one event counts once) and in first-seen order. This is matching
/// ONLY: no debounce, no read, no side effects. Debounce gating and reading
/// happen in `process_candidates`, so a path that matches but can't be read never
/// records a debounce timestamp.
///
/// notify can batch several changed paths into one event (it commonly does when
/// they share a parent directory — and we always watch parent dirs). Each path is
/// matched independently so a non-match never aborts the rest. A deleted/
/// renamed-away watched path still canonicalizes to itself (the fallback) and so
/// still matches here — that's intended; the read in `process_candidates` is what
/// then fails harmlessly and lets a follow-up recreate retry.
pub(crate) fn collect_candidates(
    event_paths: &[PathBuf],
    watched_files: &HashMap<String, PathBuf>,
) -> Vec<String> {
    let mut keys = Vec::new();
    for event_path in event_paths {
        let canon = event_path
            .canonicalize()
            .unwrap_or_else(|_| event_path.clone());
        for (key, watched_path) in watched_files.iter() {
            if canon == *watched_path {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
                break;
            }
        }
    }
    keys
}

/// Gate each candidate key on its OWN debounce window, attempt a read via `read`,
/// and record the debounce timestamp ONLY after a successful read. Returns the
/// `(canonical_key, content)` to deliver, in candidate order.
///
/// Recording the debounce timestamp AFTER a successful read (not at match time)
/// is the crux: a `Modify(Name)`/delete delivered for a watched path still matches
/// the watched set (canonicalize falls back to the path as-is), but the read then
/// fails. If we recorded the debounce at match time, a recreate/modify arriving
/// within `debounce_ms` would be dropped — the editor would keep stale content,
/// and a later Cmd+S could overwrite the external change. By recording only on a
/// successful read, a failed read never consumes the debounce window, so the next
/// event for the same key is still delivered. The debounce CHECK still runs before
/// the read so a burst of successful duplicate events for one save emits once.
pub(crate) fn process_candidates<F>(
    candidates: &[String],
    last_emit: &mut HashMap<String, u64>,
    now_ms: u64,
    debounce_ms: u64,
    mut read: F,
) -> Vec<(String, String)>
where
    F: FnMut(&str) -> Option<String>,
{
    let mut emits = Vec::new();
    for key in candidates {
        let last = last_emit.get(key).copied().unwrap_or(0);
        if !should_emit(now_ms, last, debounce_ms) {
            continue;
        }
        if let Some(content) = read(key) {
            last_emit.insert(key.clone(), now_ms);
            emits.push((key.clone(), content));
        }
        // Read failed → do NOT record; let the next event for this key retry.
    }
    emits
}

/// Canonicalize a path and return (key, canonical) where key is the canonical path string.
pub(crate) fn prepare_file_entry(path: &std::path::Path) -> Result<(String, PathBuf), String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let key = canonical.to_string_lossy().to_string();
    Ok((key, canonical))
}

/// Insert a file entry into the WatcherState files map using canonical path as key.
pub(crate) fn register_file(state: &WatcherState, key: String, canonical: PathBuf) -> Result<(), String> {
    state.files.lock().map_err(|e| format!("Lock error: {}", e))?
        .insert(key, canonical);
    Ok(())
}

/// Add a file and rebuild the watcher to cover all files.
pub fn add_file(
    app: &tauri::AppHandle,
    state: &WatcherState,
    path: PathBuf,
) -> Result<(), String> {
    let (key, canonical) = prepare_file_entry(&path)?;
    register_file(state, key, canonical)?;
    dbg_log!("Added file: {}", path.display());

    rebuild_watcher(app, state)
}

/// Rebuild the watcher to cover all registered files.
fn rebuild_watcher(app: &tauri::AppHandle, state: &WatcherState) -> Result<(), String> {
    // Stop existing watcher (but keep files map)
    state.handle.lock().map_err(|e| format!("Lock error: {}", e))?.take();

    let files_snapshot: HashMap<String, PathBuf> = state.files.lock()
        .map_err(|e| format!("Lock error: {}", e))?.clone();
    if files_snapshot.is_empty() {
        return Ok(());
    }

    let app_handle = app.clone();
    let watched_files = Arc::new(files_snapshot.clone());
    // Per-file debounce timestamps (canonical key → last-emit ms). Tracking
    // each file independently keeps a save to one open file from
    // debounce-dropping a near-simultaneous change to another.
    let last_emit: Arc<Mutex<HashMap<String, u64>>> = Arc::new(Mutex::new(HashMap::new()));

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            match result {
                Ok(event) => {
                    if !is_relevant_event(&event.kind) {
                        return;
                    }

                    let now = now_millis();

                    // Match this event's paths to the watched set (deduped),
                    // independent of debounce/read so a non-match or an unreadable
                    // path never aborts the rest.
                    let candidates = collect_candidates(&event.paths, &watched_files);

                    // Read the CANONICAL watched path for a matched key (not the
                    // delivered event path), so we always load the file the tab
                    // represents.
                    let read = |key: &str| {
                        watched_files
                            .get(key)
                            .and_then(|p| std::fs::read_to_string(p).ok())
                    };

                    // Gate each candidate on its own debounce window; the debounce
                    // timestamp is recorded only after a successful read, so a
                    // rename-away/delete whose read fails doesn't suppress a
                    // follow-up recreate. Mutex poison is permanent, so a
                    // scratch-map fallback here would disable debouncing for the
                    // rest of the session; into_inner recovers the real map
                    // instead (the data is a plain timestamp map — there is no
                    // invariant a mid-update panic could have torn).
                    let mut map = last_emit
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let emits =
                        process_candidates(&candidates, &mut map, now, DEBOUNCE_MS, read);
                    drop(map);

                    for (key, content) in emits {
                        // Match key is the canonical path string — bridge.js
                        // stores it on `data-path`. The display name is for the
                        // tab title only.
                        if let Some(watched_path) = watched_files.get(&key) {
                            let display = display_name_from_snapshot(watched_path, &watched_files);
                            dbg_log!("File changed: {} ({})", display, key);
                        }
                        crate::commands::update_current_tab(&app_handle, &content, &key);
                    }
                }
                Err(e) => dbg_log!("Watcher error: {}", e),
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    // Watch all unique parent directories
    let mut dirs_watched = std::collections::HashSet::new();
    for path in files_snapshot.values() {
        if let Some(dir) = path.parent() {
            if dirs_watched.insert(dir.to_path_buf()) {
                watcher
                    .watch(dir, RecursiveMode::NonRecursive)
                    .map_err(|e| format!("Failed to watch {}: {}", dir.display(), e))?;
                dbg_log!("Watching dir: {}", dir.display());
            }
        }
    }

    *state.handle.lock().map_err(|e| format!("Lock error: {}", e))? = Some(watcher);
    dbg_log!("Watcher rebuilt for {} files", files_snapshot.len());
    Ok(())
}

/// Stop the active watcher and forget every watched file, returning the
/// WatcherState to its initial empty state. Backs the `reset_watcher` IPC
/// command (start a fresh session / isolate e2e scenarios from accumulated
/// watches) and is used by tests.
pub(crate) fn stop_watching(state: &WatcherState) {
    if let Ok(mut guard) = state.handle.lock() {
        guard.take();
    }
    if let Ok(mut guard) = state.files.lock() {
        guard.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
    use std::sync::atomic::{AtomicU64, Ordering};

    // --- WatcherState tests ---

    #[test]
    fn watcher_state_initial() {
        let state = WatcherState::new();
        assert!(state.handle.lock().unwrap().is_none());
        assert!(state.files.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_watching_when_not_started() {
        let state = WatcherState::new();
        stop_watching(&state);
        assert!(state.handle.lock().unwrap().is_none());
        assert!(state.files.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_watching_clears_files() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("/tmp/test.md".to_string(), PathBuf::from("/tmp/test.md"));
        stop_watching(&state);
        assert!(state.files.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_watching_twice_is_safe() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("/tmp/a.md".to_string(), PathBuf::from("/tmp/a.md"));
        stop_watching(&state);
        stop_watching(&state);
        assert!(state.files.lock().unwrap().is_empty());
    }

    // --- now_millis tests ---

    #[test]
    fn now_millis_returns_positive() {
        assert!(now_millis() > 0);
    }

    #[test]
    fn now_millis_is_monotonic() {
        let a = now_millis();
        let b = now_millis();
        assert!(b >= a);
    }

    // --- is_relevant_event tests ---

    #[test]
    fn relevant_event_modify() {
        assert!(is_relevant_event(&EventKind::Modify(ModifyKind::Data(DataChange::Content))));
    }

    #[test]
    fn relevant_event_create() {
        assert!(is_relevant_event(&EventKind::Create(CreateKind::File)));
    }

    #[test]
    fn irrelevant_event_remove() {
        assert!(!is_relevant_event(&EventKind::Remove(RemoveKind::File)));
    }

    #[test]
    fn irrelevant_event_access() {
        assert!(!is_relevant_event(&EventKind::Access(notify::event::AccessKind::Read)));
    }

    #[test]
    fn irrelevant_event_other() {
        assert!(!is_relevant_event(&EventKind::Other));
    }

    // --- should_emit tests ---

    #[test]
    fn should_emit_first_event() {
        assert!(should_emit(1000, 0, 300));
    }

    #[test]
    fn should_emit_within_debounce() {
        assert!(!should_emit(1000, 900, 300));
    }

    #[test]
    fn should_emit_at_boundary() {
        assert!(should_emit(1000, 700, 300));
    }

    #[test]
    fn should_emit_past_boundary() {
        assert!(should_emit(1000, 600, 300));
    }

    #[test]
    fn should_emit_zero_debounce() {
        assert!(should_emit(100, 100, 0));
    }

    #[test]
    fn relevant_event_modify_any() {
        assert!(is_relevant_event(&EventKind::Modify(ModifyKind::Any)));
    }

    #[test]
    fn relevant_event_create_any() {
        assert!(is_relevant_event(&EventKind::Create(CreateKind::Any)));
    }

    #[test]
    fn relevant_event_modify_name() {
        assert!(is_relevant_event(&EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::Any
        ))));
    }

    #[test]
    fn should_emit_same_timestamp() {
        assert!(should_emit(500, 500, 0));
        assert!(!should_emit(500, 500, 1));
    }

    #[test]
    fn should_emit_large_gap() {
        assert!(should_emit(1_000_000, 0, 300));
    }

    #[test]
    fn should_emit_just_under_boundary() {
        assert!(!should_emit(1299, 1000, 300));
    }

    #[test]
    fn should_emit_exactly_at_debounce() {
        assert!(should_emit(1300, 1000, 300));
    }

    #[test]
    fn should_emit_clock_backward() {
        // 시계 역행 시 panic 대신 false 반환 (saturating_sub)
        assert!(!should_emit(100, 500, 300));
    }

    #[test]
    fn stop_watching_after_adding_files() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("/tmp/a.md".to_string(), PathBuf::from("/tmp/a.md"));
        state.files.lock().unwrap().insert("/tmp/b.md".to_string(), PathBuf::from("/tmp/b.md"));
        assert_eq!(state.files.lock().unwrap().len(), 2);
        stop_watching(&state);
        assert!(state.files.lock().unwrap().is_empty());
        assert!(state.handle.lock().unwrap().is_none());
    }

    #[test]
    fn debounce_logic() {
        let last_emit = Arc::new(AtomicU64::new(0));
        let now = now_millis();
        let last = last_emit.load(Ordering::Relaxed);
        assert!(should_emit(now, last, DEBOUNCE_MS));
        last_emit.store(now, Ordering::Relaxed);
        let now2 = now_millis();
        let last2 = last_emit.load(Ordering::Relaxed);
        assert!(!should_emit(now2, last2, DEBOUNCE_MS));
    }

    // --- prepare_file_entry tests ---

    #[test]
    fn prepare_file_entry_existing_file() {
        let dir = std::env::temp_dir().join("md_desk_test_prepare");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("entry.md");
        std::fs::write(&path, "test").unwrap();

        let (key, canonical) = prepare_file_entry(&path).unwrap();
        // Key is now canonical path string, not filename
        assert!(key.ends_with("entry.md"));
        assert!(key.starts_with("/"));
        assert!(canonical.is_absolute());
        // canonical should resolve to the same file
        assert_eq!(std::fs::read_to_string(&canonical).unwrap(), "test");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn prepare_file_entry_nonexistent() {
        let path = PathBuf::from("/nonexistent_99999/missing.md");
        assert!(prepare_file_entry(&path).is_err());
    }

    #[test]
    fn prepare_file_entry_symlink() {
        let dir = std::env::temp_dir().join("md_desk_test_prepare_sym");
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        std::fs::write(&real, "content").unwrap();
        // skip if symlink creation fails (permissions)
        if std::os::unix::fs::symlink(&real, &link).is_ok() {
            let (key, canonical) = prepare_file_entry(&link).unwrap();
            // Key is canonical path (resolves through symlink to real.md)
            assert!(key.ends_with("real.md"));
            // canonical should resolve through the symlink
            assert_eq!(canonical, real.canonicalize().unwrap());
            let _ = std::fs::remove_file(&link);
        }
        let _ = std::fs::remove_file(&real);
        let _ = std::fs::remove_dir(&dir);
    }

    // --- register_file tests ---

    #[test]
    fn register_file_adds_to_map() {
        let state = WatcherState::new();
        let canonical = PathBuf::from("/tmp/test.md");
        assert!(register_file(&state, "test.md".to_string(), canonical.clone()).is_ok());
        assert_eq!(state.files.lock().unwrap().get("test.md"), Some(&canonical));
    }

    #[test]
    fn register_file_overwrites_existing() {
        let state = WatcherState::new();
        let path1 = PathBuf::from("/tmp/old.md");
        let path2 = PathBuf::from("/tmp/new.md");
        register_file(&state, "test.md".to_string(), path1).unwrap();
        register_file(&state, "test.md".to_string(), path2.clone()).unwrap();
        assert_eq!(state.files.lock().unwrap().get("test.md"), Some(&path2));
    }

    #[test]
    fn register_file_multiple_entries() {
        let state = WatcherState::new();
        register_file(&state, "a.md".to_string(), PathBuf::from("/tmp/a.md")).unwrap();
        register_file(&state, "b.md".to_string(), PathBuf::from("/tmp/b.md")).unwrap();
        register_file(&state, "c.md".to_string(), PathBuf::from("/tmp/c.md")).unwrap();
        assert_eq!(state.files.lock().unwrap().len(), 3);
    }

    // --- display_name_from_snapshot tests ---

    #[test]
    fn display_name_no_conflict() {
        let mut files = HashMap::new();
        files.insert("/tmp/notes.md".to_string(), PathBuf::from("/tmp/notes.md"));
        assert_eq!(
            display_name_from_snapshot(std::path::Path::new("/tmp/notes.md"), &files),
            "notes.md"
        );
    }

    #[test]
    fn display_name_with_conflict() {
        let mut files = HashMap::new();
        files.insert("/tmp/a/notes.md".to_string(), PathBuf::from("/tmp/a/notes.md"));
        files.insert("/tmp/b/notes.md".to_string(), PathBuf::from("/tmp/b/notes.md"));
        assert_eq!(
            display_name_from_snapshot(std::path::Path::new("/tmp/b/notes.md"), &files),
            "b/notes.md"
        );
    }

    #[test]
    fn display_name_same_path_no_conflict() {
        let mut files = HashMap::new();
        files.insert("/tmp/notes.md".to_string(), PathBuf::from("/tmp/notes.md"));
        // Same path should not count as a conflict
        assert_eq!(
            display_name_from_snapshot(std::path::Path::new("/tmp/notes.md"), &files),
            "notes.md"
        );
    }

    #[test]
    fn display_name_three_way_conflict() {
        let mut files = HashMap::new();
        files.insert("/tmp/a/notes.md".to_string(), PathBuf::from("/tmp/a/notes.md"));
        files.insert("/tmp/b/notes.md".to_string(), PathBuf::from("/tmp/b/notes.md"));
        files.insert("/tmp/c/notes.md".to_string(), PathBuf::from("/tmp/c/notes.md"));
        assert_eq!(
            display_name_from_snapshot(std::path::Path::new("/tmp/a/notes.md"), &files),
            "a/notes.md"
        );
        assert_eq!(
            display_name_from_snapshot(std::path::Path::new("/tmp/c/notes.md"), &files),
            "c/notes.md"
        );
    }

    // Shared helper for the matching tests. Paths that don't exist on disk make
    // canonicalize() fall back to the path as-is, so matching against an equal
    // PathBuf works without touching the filesystem — this also mirrors the
    // deleted/rename-away case where the watched path no longer resolves.
    fn watched(paths: &[&str]) -> HashMap<String, PathBuf> {
        paths
            .iter()
            .map(|p| (p.to_string(), PathBuf::from(p)))
            .collect()
    }

    // --- collect_candidates (per-event matching + dedup, no debounce/read) tests ---

    #[test]
    fn collect_candidates_single_watched_path() {
        let w = watched(&["/x/a.md"]);
        let c = collect_candidates(&[PathBuf::from("/x/a.md")], &w);
        assert_eq!(c, vec!["/x/a.md".to_string()]);
    }

    #[test]
    fn collect_candidates_two_paths_one_event_both_match() {
        let w = watched(&["/x/a.md", "/x/b.md"]);
        let c = collect_candidates(&[PathBuf::from("/x/a.md"), PathBuf::from("/x/b.md")], &w);
        assert_eq!(c.len(), 2);
        assert!(c.contains(&"/x/a.md".to_string()));
        assert!(c.contains(&"/x/b.md".to_string()));
    }

    #[test]
    fn collect_candidates_unwatched_path_filtered_out() {
        // An unwatched sibling in the same event must be skipped without aborting
        // the watched one.
        let w = watched(&["/x/b.md"]);
        let c = collect_candidates(&[PathBuf::from("/x/junk.tmp"), PathBuf::from("/x/b.md")], &w);
        assert_eq!(c, vec!["/x/b.md".to_string()]);
    }

    #[test]
    fn collect_candidates_duplicate_path_deduped() {
        // Same watched path twice in one event → one candidate (we don't want to
        // read + render the same file twice for a single event).
        let w = watched(&["/x/a.md"]);
        let c = collect_candidates(&[PathBuf::from("/x/a.md"), PathBuf::from("/x/a.md")], &w);
        assert_eq!(c, vec!["/x/a.md".to_string()]);
    }

    #[test]
    fn collect_candidates_preserves_first_seen_order() {
        let w = watched(&["/x/a.md", "/x/b.md"]);
        let c = collect_candidates(&[PathBuf::from("/x/b.md"), PathBuf::from("/x/a.md")], &w);
        assert_eq!(c, vec!["/x/b.md".to_string(), "/x/a.md".to_string()]);
    }

    #[test]
    fn collect_candidates_empty_paths() {
        let w = watched(&["/x/a.md"]);
        assert!(collect_candidates(&[], &w).is_empty());
    }

    #[test]
    fn collect_candidates_no_watched_files() {
        let w = HashMap::new();
        assert!(collect_candidates(&[PathBuf::from("/x/a.md")], &w).is_empty());
    }

    // --- process_candidates (debounce gating + read-then-record) tests ---

    #[test]
    fn process_candidates_failed_read_does_not_consume_debounce() {
        // THE BUG: a rename-away/delete delivered for a watched path matches the
        // watched set (canonicalize fallback), but the read then fails. If we
        // record the debounce timestamp at match time (before the read), a
        // recreate within DEBOUNCE_MS is dropped → editor stays stale → a later
        // Cmd+S can overwrite the external change with old content. A failed read
        // must NOT consume the debounce window, so the recreate still emits.
        let mut last = HashMap::new();
        // Event 1: rename-away — read fails.
        let emits1 = process_candidates(&["/x/d.md".to_string()], &mut last, 1000, 300, |_k| None);
        assert!(emits1.is_empty());
        assert_eq!(
            last.get("/x/d.md"),
            None,
            "a failed read must not record a debounce timestamp"
        );
        // Event 2: recreate 100ms later (within 300ms) — read succeeds → emits.
        let emits2 = process_candidates(&["/x/d.md".to_string()], &mut last, 1100, 300, |_k| {
            Some("new content".to_string())
        });
        assert_eq!(
            emits2,
            vec![("/x/d.md".to_string(), "new content".to_string())]
        );
        assert_eq!(last.get("/x/d.md"), Some(&1100));
    }

    #[test]
    fn process_candidates_successful_read_emits_and_records() {
        let mut last = HashMap::new();
        let emits = process_candidates(&["/x/a.md".to_string()], &mut last, 1000, 300, |_k| {
            Some("hello".to_string())
        });
        assert_eq!(emits, vec![("/x/a.md".to_string(), "hello".to_string())]);
        assert_eq!(last.get("/x/a.md"), Some(&1000));
    }

    #[test]
    fn process_candidates_debounced_candidate_is_not_read() {
        // A candidate still inside its debounce window must be skipped WITHOUT
        // reading (the read check comes after the debounce gate), and its
        // timestamp must not advance.
        let mut last = HashMap::new();
        last.insert("/x/a.md".to_string(), 900);
        let mut reads = 0;
        let emits = process_candidates(&["/x/a.md".to_string()], &mut last, 1000, 300, |_k| {
            reads += 1;
            Some("x".to_string())
        });
        assert!(emits.is_empty());
        assert_eq!(reads, 0, "a debounced candidate must not be read");
        assert_eq!(last.get("/x/a.md"), Some(&900));
    }

    #[test]
    fn process_candidates_independent_keys_one_debounced_one_fresh() {
        // A is debounced (won't read/emit), B is fresh (reads/emits). Keys are
        // gated independently — A must not suppress B.
        let mut last = HashMap::new();
        last.insert("/x/a.md".to_string(), 900);
        let emits = process_candidates(
            &["/x/a.md".to_string(), "/x/b.md".to_string()],
            &mut last,
            1000,
            300,
            |key| Some(format!("content:{}", key)),
        );
        assert_eq!(
            emits,
            vec![("/x/b.md".to_string(), "content:/x/b.md".to_string())]
        );
        assert_eq!(last.get("/x/a.md"), Some(&900)); // unchanged
        assert_eq!(last.get("/x/b.md"), Some(&1000));
    }

    #[test]
    fn process_candidates_burst_of_successful_events_emits_once() {
        // Three successful events for one save within the debounce window emit
        // exactly once (the debounce CHECK still runs before the read).
        let mut last = HashMap::new();
        let mut total = Vec::new();
        for now in [1000u64, 1100, 1200] {
            let e =
                process_candidates(&["/x/a.md".to_string()], &mut last, now, 300, |_k| {
                    Some("v".to_string())
                });
            total.extend(e);
        }
        assert_eq!(total, vec![("/x/a.md".to_string(), "v".to_string())]);
        assert_eq!(last.get("/x/a.md"), Some(&1000));
    }

    #[test]
    fn process_candidates_empty_candidates() {
        let mut last = HashMap::new();
        let emits = process_candidates(&[], &mut last, 1000, 300, |_k| Some("x".to_string()));
        assert!(emits.is_empty());
        assert!(last.is_empty());
    }

    // --- Info.plist App Nap opt-out (build-config tripwire) ---
    // The "live reload while the window is visible-but-not-focused" feature has
    // two halves: the focus/visibility fallback (auto-refresh.spec.js) and
    // disabling macOS App Nap so the WebView's debounced render timer keeps firing
    // in the background. The App Nap half lives ONLY in the bundled Info.plist —
    // no unit/e2e exercises it — so a deletion or typo would silently regress in
    // production. These pin the source plist that Tauri merges at bundle time.
    // (include_str! also fails the build outright if Info.plist is removed.)

    fn nsappsleepdisabled_is_true(plist: &str) -> bool {
        plist
            .split("<key>NSAppSleepDisabled</key>")
            .nth(1)
            .map(|after| after.trim_start().starts_with("<true/>"))
            .unwrap_or(false)
    }

    #[test]
    fn app_nap_check_discriminates() {
        // Guard the guard: the check must reject a flipped value or a missing key,
        // so the real-plist assertion below can't pass vacuously.
        assert!(nsappsleepdisabled_is_true(
            "<dict>\n  <key>NSAppSleepDisabled</key>\n  <true/>\n</dict>"
        ));
        assert!(!nsappsleepdisabled_is_true(
            "<dict>\n  <key>NSAppSleepDisabled</key>\n  <false/>\n</dict>"
        ));
        assert!(!nsappsleepdisabled_is_true("<dict></dict>"));
    }

    #[test]
    fn info_plist_opts_out_of_app_nap() {
        // The source plist Tauri merges at bundle time must declare
        // NSAppSleepDisabled = true, or background live-reload silently regresses.
        let plist = include_str!("../Info.plist");
        assert!(
            nsappsleepdisabled_is_true(plist),
            "src-tauri/Info.plist must set <key>NSAppSleepDisabled</key><true/> \
             (opt out of macOS App Nap for background live-reload)"
        );
    }
}
