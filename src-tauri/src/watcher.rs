use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const DEBOUNCE_MS: u64 = 300;

pub struct WatcherState {
    pub handle: Mutex<Option<RecommendedWatcher>>,
    pub current_path: Mutex<Option<PathBuf>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            handle: Mutex::new(None),
            current_path: Mutex::new(None),
        }
    }
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

/// Returns true if any path in the event matches the target (after canonicalization).
pub(crate) fn event_matches_target(event_paths: &[PathBuf], target: &PathBuf) -> bool {
    event_paths
        .iter()
        .any(|p| p.canonicalize().unwrap_or_else(|_| p.clone()) == *target)
}

/// Returns true if enough time has passed since last_ms (debounce check).
pub(crate) fn should_emit(now_ms: u64, last_ms: u64, debounce_ms: u64) -> bool {
    now_ms - last_ms >= debounce_ms
}

pub fn start_watching(
    app: &tauri::AppHandle,
    state: &WatcherState,
    path: PathBuf,
) -> Result<(), String> {
    stop_watching(state);

    let app_handle = app.clone();
    let target_path = path.canonicalize().map_err(|e| e.to_string())?;
    let watch_path = path.clone();
    let last_emit = Arc::new(AtomicU64::new(0));

    dbg_log!("Target: {}", target_path.display());

    let mut watcher = RecommendedWatcher::new(
        move |result: Result<notify::Event, notify::Error>| {
            match result {
                Ok(event) => {
                    if !is_relevant_event(&event.kind) {
                        return;
                    }
                    if !event_matches_target(&event.paths, &target_path) {
                        return;
                    }

                    let now = now_millis();
                    let last = last_emit.load(Ordering::Relaxed);
                    if !should_emit(now, last, DEBOUNCE_MS) {
                        return;
                    }
                    last_emit.store(now, Ordering::Relaxed);

                    dbg_log!("File changed, injecting...");
                    match std::fs::read_to_string(&watch_path) {
                        Ok(content) => {
                            let filename = crate::commands::filename_from_path(&watch_path);
                            crate::commands::update_current_tab(
                                &app_handle, &content, &filename,
                            );
                            dbg_log!("Inject done");
                        }
                        Err(e) => dbg_log!("Read error: {}", e),
                    }
                }
                Err(e) => dbg_log!("Error: {}", e),
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    let watch_dir = path
        .parent()
        .ok_or_else(|| "Cannot get parent directory".to_string())?;
    dbg_log!("Watching dir: {}", watch_dir.display());

    watcher
        .watch(watch_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch: {}", e))?;

    *state.handle.lock().unwrap() = Some(watcher);
    *state.current_path.lock().unwrap() = Some(path);

    dbg_log!("Watch started OK");
    Ok(())
}

pub fn stop_watching(state: &WatcherState) {
    if state.handle.lock().unwrap().take().is_some() {
        dbg_log!("Stopped");
    }
    let _ = state.current_path.lock().unwrap().take();
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
    use std::fs;

    // --- WatcherState tests ---

    #[test]
    fn watcher_state_initial() {
        let state = WatcherState::new();
        assert!(state.handle.lock().unwrap().is_none());
        assert!(state.current_path.lock().unwrap().is_none());
    }

    #[test]
    fn stop_watching_when_not_started() {
        let state = WatcherState::new();
        stop_watching(&state);
        assert!(state.handle.lock().unwrap().is_none());
        assert!(state.current_path.lock().unwrap().is_none());
    }

    #[test]
    fn stop_watching_clears_path() {
        let state = WatcherState::new();
        *state.current_path.lock().unwrap() = Some(PathBuf::from("/tmp/test.md"));
        stop_watching(&state);
        assert!(state.current_path.lock().unwrap().is_none());
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
        assert!(is_relevant_event(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
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
        assert!(!is_relevant_event(&EventKind::Access(
            notify::event::AccessKind::Read
        )));
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

    // --- event_matches_target tests ---

    #[test]
    fn event_matches_target_with_match() {
        let dir = std::env::temp_dir().join("md_test_match");
        fs::create_dir_all(&dir).ok();
        let file = dir.join("target.md");
        fs::write(&file, "test").unwrap();
        let target = file.canonicalize().unwrap();

        assert!(event_matches_target(&[file.clone()], &target));
        fs::remove_file(&file).ok();
    }

    #[test]
    fn event_matches_target_no_match() {
        let dir = std::env::temp_dir().join("md_test_nomatch");
        fs::create_dir_all(&dir).ok();
        let file_a = dir.join("a.md");
        let file_b = dir.join("b.md");
        fs::write(&file_a, "a").unwrap();
        fs::write(&file_b, "b").unwrap();
        let target = file_a.canonicalize().unwrap();

        assert!(!event_matches_target(&[file_b.clone()], &target));
        fs::remove_file(&file_a).ok();
        fs::remove_file(&file_b).ok();
    }

    #[test]
    fn event_matches_target_empty_paths() {
        let target = PathBuf::from("/tmp/nonexistent.md");
        assert!(!event_matches_target(&[], &target));
    }

    // --- debounce integration test ---

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

    // --- is_relevant_event edge cases ---

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

    // --- should_emit edge cases ---

    #[test]
    fn should_emit_same_timestamp() {
        // Same time with 0 debounce → emit
        assert!(should_emit(500, 500, 0));
        // Same time with any debounce → no emit
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
        // 1300 - 1000 = 300, which equals debounce → should emit
        assert!(should_emit(1300, 1000, 300));
    }

    // --- event_matches_target edge cases ---

    #[test]
    fn event_matches_target_multiple_paths_one_match() {
        let dir = std::env::temp_dir().join("md_test_multi");
        fs::create_dir_all(&dir).ok();
        let target_file = dir.join("target.md");
        let other_file = dir.join("other.md");
        fs::write(&target_file, "t").unwrap();
        fs::write(&other_file, "o").unwrap();
        let target = target_file.canonicalize().unwrap();

        // Multiple paths, only one matches
        assert!(event_matches_target(
            &[other_file.clone(), target_file.clone()],
            &target
        ));

        fs::remove_file(&target_file).ok();
        fs::remove_file(&other_file).ok();
    }

    #[test]
    fn event_matches_target_multiple_paths_none_match() {
        let dir = std::env::temp_dir().join("md_test_none");
        fs::create_dir_all(&dir).ok();
        let a = dir.join("a.md");
        let b = dir.join("b.md");
        let target_file = dir.join("target.md");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        fs::write(&target_file, "t").unwrap();
        let target = target_file.canonicalize().unwrap();

        assert!(!event_matches_target(&[a.clone(), b.clone()], &target));

        fs::remove_file(&a).ok();
        fs::remove_file(&b).ok();
        fs::remove_file(&target_file).ok();
    }

    #[test]
    fn event_matches_target_nonexistent_event_path() {
        let dir = std::env::temp_dir().join("md_test_nonexist");
        fs::create_dir_all(&dir).ok();
        let target_file = dir.join("exists.md");
        fs::write(&target_file, "x").unwrap();
        let target = target_file.canonicalize().unwrap();

        // Event path doesn't exist on disk — canonicalize falls back to clone
        let fake = dir.join("doesnotexist.md");
        assert!(!event_matches_target(&[fake], &target));

        fs::remove_file(&target_file).ok();
    }

    // --- WatcherState edge cases ---

    #[test]
    fn stop_watching_twice_is_safe() {
        let state = WatcherState::new();
        *state.current_path.lock().unwrap() = Some(PathBuf::from("/tmp/a.md"));
        stop_watching(&state);
        stop_watching(&state);
        assert!(state.current_path.lock().unwrap().is_none());
    }

    #[test]
    fn watcher_state_set_and_clear_path() {
        let state = WatcherState::new();
        let path = PathBuf::from("/tmp/test.md");
        *state.current_path.lock().unwrap() = Some(path.clone());
        assert_eq!(
            state.current_path.lock().unwrap().as_ref().unwrap(),
            &path
        );
        stop_watching(&state);
        assert!(state.current_path.lock().unwrap().is_none());
    }
}
