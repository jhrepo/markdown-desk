use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Look up the file path for a given tab title (filename or title without .md).
/// Keys are canonical path strings; this searches by matching the filename component.
/// Uses 2-pass approach: exact filename match first, then extension-stripped fallback.
pub fn path_for_title(state: &WatcherState, title: &str) -> Option<PathBuf> {
    let files = state.files.lock().ok()?;
    // Pass 0: "dir/filename.md" display name → match parent + filename
    if let Some((dir, fname)) = title.split_once('/') {
        for canonical in files.values() {
            if crate::commands::filename_from_path(canonical) == fname {
                if let Some(parent) = canonical.parent().and_then(|p| p.file_name()) {
                    if parent.to_string_lossy() == dir {
                        return Some(canonical.clone());
                    }
                }
            }
        }
    }
    // Pass 1: exact filename match
    for canonical in files.values() {
        if crate::commands::filename_from_path(canonical) == title {
            return Some(canonical.clone());
        }
    }
    // Pass 2: strip .md/.markdown extension
    for canonical in files.values() {
        let fname = crate::commands::filename_from_path(canonical);
        if let Some(stem) = fname.strip_suffix(".md").or_else(|| fname.strip_suffix(".markdown")) {
            if stem == title {
                return Some(canonical.clone());
            }
        }
    }
    None
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
    let last_emit = Arc::new(AtomicU64::new(0));

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            match result {
                Ok(event) => {
                    if !is_relevant_event(&event.kind) {
                        return;
                    }

                    let now = now_millis();
                    let last = last_emit.load(Ordering::Relaxed);
                    if !should_emit(now, last, DEBOUNCE_MS) {
                        return;
                    }

                    for event_path in &event.paths {
                        let canon = event_path
                            .canonicalize()
                            .unwrap_or_else(|_| event_path.clone());

                        for (_key, watched_path) in watched_files.iter() {
                            if canon == *watched_path {
                                last_emit.store(now, Ordering::Relaxed);
                                let display = display_name_from_snapshot(watched_path, &watched_files);
                                dbg_log!("File changed: {}", display);
                                if let Ok(content) = std::fs::read_to_string(event_path) {
                                    crate::commands::update_current_tab(
                                        &app_handle, &content, &display,
                                    );
                                }
                                return;
                            }
                        }
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

/// Stop watching all files and clear the file list.
#[cfg(test)]
fn stop_watching(state: &WatcherState) {
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

    // --- path_for_title tests ---

    #[test]
    fn path_for_title_exact() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/test.md");
        state.files.lock().unwrap().insert("/tmp/test.md".to_string(), path.clone());
        assert_eq!(path_for_title(&state, "test.md"), Some(path));
    }

    #[test]
    fn path_for_title_without_extension() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/test.md");
        state.files.lock().unwrap().insert("/tmp/test.md".to_string(), path.clone());
        assert_eq!(path_for_title(&state, "test"), Some(path));
    }

    #[test]
    fn path_for_title_not_found() {
        let state = WatcherState::new();
        assert_eq!(path_for_title(&state, "missing.md"), None);
    }

    #[test]
    fn path_for_title_multiple_files() {
        let state = WatcherState::new();
        let path_a = PathBuf::from("/tmp/a.md");
        let path_b = PathBuf::from("/tmp/b.md");
        state.files.lock().unwrap().insert("/tmp/a.md".to_string(), path_a.clone());
        state.files.lock().unwrap().insert("/tmp/b.md".to_string(), path_b.clone());
        assert_eq!(path_for_title(&state, "a.md"), Some(path_a));
        assert_eq!(path_for_title(&state, "b"), Some(path_b));
    }

    #[test]
    fn path_for_title_empty_string() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("/tmp/test.md".to_string(), PathBuf::from("/tmp/test.md"));
        assert_eq!(path_for_title(&state, ""), None);
    }

    #[test]
    fn path_for_title_case_sensitive() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("/tmp/Test.md".to_string(), PathBuf::from("/tmp/Test.md"));
        // 대소문자 구분
        assert_eq!(path_for_title(&state, "test"), None);
        assert_eq!(path_for_title(&state, "Test"), Some(PathBuf::from("/tmp/Test.md")));
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
    fn path_for_title_prefers_exact_filename() {
        let state = WatcherState::new();
        let path_exact = PathBuf::from("/tmp/README");
        let path_md = PathBuf::from("/tmp/README.md");
        state.files.lock().unwrap().insert("/tmp/README".to_string(), path_exact.clone());
        state.files.lock().unwrap().insert("/tmp/README.md".to_string(), path_md.clone());
        // "README" matches filename "README" exactly
        assert_eq!(path_for_title(&state, "README"), Some(path_exact));
    }

    #[test]
    fn path_for_title_fallback_strips_md() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/notes.md");
        state.files.lock().unwrap().insert("/tmp/notes.md".to_string(), path.clone());
        // "notes" should find "notes.md" via fallback
        assert_eq!(path_for_title(&state, "notes"), Some(path));
        // "notes.txt" should not match
        assert_eq!(path_for_title(&state, "notes.txt"), None);
    }

    #[test]
    fn path_for_title_unicode_filename() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/메모.md");
        state.files.lock().unwrap().insert("/tmp/메모.md".to_string(), path.clone());
        assert_eq!(path_for_title(&state, "메모"), Some(path));
    }

    #[test]
    fn path_for_title_display_name_with_dir_prefix() {
        // display_name_for_file produces "b/notes.md" for conflict; path_for_title must resolve it
        let state = WatcherState::new();
        let path_a = PathBuf::from("/tmp/a/notes.md");
        let path_b = PathBuf::from("/tmp/b/notes.md");
        state.files.lock().unwrap().insert("/tmp/a/notes.md".to_string(), path_a.clone());
        state.files.lock().unwrap().insert("/tmp/b/notes.md".to_string(), path_b.clone());
        assert_eq!(path_for_title(&state, "b/notes.md"), Some(path_b));
        assert_eq!(path_for_title(&state, "a/notes.md"), Some(path_a));
    }

    #[test]
    fn path_for_title_display_name_nonexistent_dir() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/a/notes.md");
        state.files.lock().unwrap().insert("/tmp/a/notes.md".to_string(), path.clone());
        // "c/notes.md" has correct filename but wrong dir prefix
        assert_eq!(path_for_title(&state, "c/notes.md"), None);
    }

    #[test]
    fn path_for_title_plain_filename_still_works_with_conflicts() {
        // Even when conflicts exist, plain "notes.md" should still return one of them
        let state = WatcherState::new();
        let path_a = PathBuf::from("/tmp/a/notes.md");
        let path_b = PathBuf::from("/tmp/b/notes.md");
        state.files.lock().unwrap().insert("/tmp/a/notes.md".to_string(), path_a.clone());
        state.files.lock().unwrap().insert("/tmp/b/notes.md".to_string(), path_b.clone());
        let result = path_for_title(&state, "notes.md");
        assert!(result == Some(path_a) || result == Some(path_b));
    }

    #[test]
    fn path_for_title_same_filename_different_dirs() {
        let state = WatcherState::new();
        let path_a = PathBuf::from("/tmp/a/notes.md");
        let path_b = PathBuf::from("/tmp/b/notes.md");
        state.files.lock().unwrap().insert("/tmp/a/notes.md".to_string(), path_a.clone());
        state.files.lock().unwrap().insert("/tmp/b/notes.md".to_string(), path_b.clone());
        // Both have filename "notes.md"; path_for_title returns one of them (non-deterministic)
        let result = path_for_title(&state, "notes.md");
        assert!(result == Some(path_a) || result == Some(path_b));
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
}
