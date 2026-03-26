use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DEBOUNCE_MS: u64 = 300;

pub struct WatcherState {
    pub handle: Mutex<Option<RecommendedWatcher>>,
    /// filename → canonical path for all opened files
    pub files: Mutex<HashMap<String, PathBuf>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            files: Mutex::new(HashMap::new()),
        }
    }
}

/// Look up the file path for a given tab title (filename or title without .md).
pub fn path_for_title(state: &WatcherState, title: &str) -> Option<PathBuf> {
    let files = state.files.lock().unwrap();
    files.get(title).cloned().or_else(|| {
        let with_ext = format!("{}.md", title);
        files.get(&with_ext).cloned()
    })
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
    now_ms - last_ms >= debounce_ms
}

/// Add a file and rebuild the watcher to cover all files.
pub fn add_file(
    app: &tauri::AppHandle,
    state: &WatcherState,
    path: PathBuf,
) -> Result<(), String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let filename = crate::commands::filename_from_path(&path);

    state.files.lock().unwrap().insert(filename.clone(), canonical);
    dbg_log!("Added file: {}", filename);

    rebuild_watcher(app, state)
}

/// Rebuild the watcher to cover all registered files.
fn rebuild_watcher(app: &tauri::AppHandle, state: &WatcherState) -> Result<(), String> {
    // Stop existing watcher (but keep files map)
    state.handle.lock().unwrap().take();

    let files_snapshot: HashMap<String, PathBuf> = state.files.lock().unwrap().clone();
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

                        for (fname, watched_path) in watched_files.iter() {
                            if canon == *watched_path {
                                last_emit.store(now, Ordering::Relaxed);
                                dbg_log!("File changed: {}", fname);
                                if let Ok(content) = std::fs::read_to_string(event_path) {
                                    crate::commands::update_current_tab(
                                        &app_handle, &content, fname,
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

    *state.handle.lock().unwrap() = Some(watcher);
    dbg_log!("Watcher rebuilt for {} files", files_snapshot.len());
    Ok(())
}

#[allow(dead_code)]
pub fn stop_watching(state: &WatcherState) {
    if state.handle.lock().unwrap().take().is_some() {
        dbg_log!("Stopped");
    }
    state.files.lock().unwrap().clear();
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
        state.files.lock().unwrap().insert("test.md".to_string(), PathBuf::from("/tmp/test.md"));
        stop_watching(&state);
        assert!(state.files.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_watching_twice_is_safe() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("a.md".to_string(), PathBuf::from("/tmp/a.md"));
        stop_watching(&state);
        stop_watching(&state);
        assert!(state.files.lock().unwrap().is_empty());
    }

    // --- path_for_title tests ---

    #[test]
    fn path_for_title_exact() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/test.md");
        state.files.lock().unwrap().insert("test.md".to_string(), path.clone());
        assert_eq!(path_for_title(&state, "test.md"), Some(path));
    }

    #[test]
    fn path_for_title_without_extension() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/test.md");
        state.files.lock().unwrap().insert("test.md".to_string(), path.clone());
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
        state.files.lock().unwrap().insert("a.md".to_string(), path_a.clone());
        state.files.lock().unwrap().insert("b.md".to_string(), path_b.clone());
        assert_eq!(path_for_title(&state, "a.md"), Some(path_a));
        assert_eq!(path_for_title(&state, "b"), Some(path_b));
    }

    #[test]
    fn path_for_title_empty_string() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("test.md".to_string(), PathBuf::from("/tmp/test.md"));
        assert_eq!(path_for_title(&state, ""), None);
    }

    #[test]
    fn path_for_title_case_sensitive() {
        let state = WatcherState::new();
        state.files.lock().unwrap().insert("Test.md".to_string(), PathBuf::from("/tmp/Test.md"));
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
}
