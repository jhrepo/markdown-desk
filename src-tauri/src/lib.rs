mod commands;
mod default_app;
#[macro_use]
mod logger;
mod menu;
mod watcher;

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

/// Return the window state flags to persist across sessions.
/// Saves position, size, maximized, and fullscreen state.
/// Excludes VISIBLE (always show) and DECORATIONS (always default).
fn window_state_flags() -> StateFlags {
    StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN
}

/// Queue for files opened via file association before the window is ready.
struct PendingFiles(Mutex<Vec<std::path::PathBuf>>);

/// Drain all pending files from the queue.
fn drain_pending(pending: &PendingFiles) -> Vec<std::path::PathBuf> {
    pending.0.lock().map(|mut g| g.drain(..).collect()).unwrap_or_else(|e| {
        dbg_log!("[file-assoc] Failed to lock pending files: {}", e);
        Vec::new()
    })
}

/// Push a file path into the pending queue.
fn push_pending(pending: &PendingFiles, path: std::path::PathBuf) -> Result<(), String> {
    pending.0.lock().map_err(|e| format!("Lock error: {}", e))?.push(path);
    Ok(())
}

pub fn run() {
    logger::init();
    dbg_log!("App starting...");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(window_state_flags())
            .build());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let app = builder
        .manage(watcher::WatcherState::new())
        .manage(PendingFiles(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
                commands::native_open_file,
                commands::restore_watcher,
                commands::refresh_active_tab,
                commands::save_file,
                commands::export_text_file,
                commands::export_binary_file,
                commands::is_default_md_app,
                commands::set_default_md_app,
                commands::set_update_title_suffix,
                commands::open_release_page,
            ])
        .setup(|app| {
            dbg_log!("Setup: building menu");
            let handle = app.handle();
            let menu = menu::build_menu(handle)?;
            app.set_menu(menu)?;
            menu::setup_menu_events(handle);

            // Process any files that were queued before the window was ready
            let app_handle = handle.clone();
            std::thread::spawn(move || {
                // Wait for the webview to be ready
                std::thread::sleep(std::time::Duration::from_secs(2));
                let pending = app_handle.state::<PendingFiles>();
                let files = drain_pending(&pending);
                for path in files {
                    dbg_log!("[file-assoc] Processing queued file: {}", path.display());
                    commands::open_file_directly(&app_handle, path);
                }
            });

            dbg_log!("Setup complete");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                dbg_log!("[file-assoc] Received URL: {}", url);
                let path = url_to_path(&url.to_string());
                if path.exists() {
                    // Try to open directly; if window not ready, queue it
                    if app_handle.get_webview_window("main").is_some() {
                        commands::open_file_directly(app_handle, path);
                    } else {
                        let pending = app_handle.state::<PendingFiles>();
                        if let Err(e) = push_pending(&pending, path) {
                            dbg_log!("[file-assoc] {}", e);
                        }
                    }
                }
            }
        }
    });
}

fn url_to_path(url: &str) -> std::path::PathBuf {
    if let Some(path_str) = url.strip_prefix("file://") {
        let decoded = percent_decode(path_str);
        std::path::PathBuf::from(decoded)
    } else {
        std::path::PathBuf::from(url)
    }
}

/// Decode percent-encoded characters in a URL path (e.g., %20 → space, %ED%95%9C → 한).
fn percent_decode(input: &str) -> String {
    let raw = input.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let (Some(h), Some(l)) = (hex_val(raw[i + 1]), hex_val(raw[i + 2])) {
                bytes.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_to_path_file_url() {
        let path = url_to_path("file:///Users/test/file.md");
        assert_eq!(path, std::path::PathBuf::from("/Users/test/file.md"));
    }

    #[test]
    fn url_to_path_with_spaces() {
        let path = url_to_path("file:///Users/test/my%20documents/file.md");
        assert_eq!(path, std::path::PathBuf::from("/Users/test/my documents/file.md"));
    }

    #[test]
    fn url_to_path_plain_path() {
        let path = url_to_path("/Users/test/file.md");
        assert_eq!(path, std::path::PathBuf::from("/Users/test/file.md"));
    }

    // --- percent_decode tests ---

    #[test]
    fn percent_decode_no_encoding() {
        assert_eq!(percent_decode("/Users/test/file.md"), "/Users/test/file.md");
    }

    #[test]
    fn percent_decode_space() {
        assert_eq!(percent_decode("/my%20file.md"), "/my file.md");
    }

    #[test]
    fn percent_decode_korean() {
        assert_eq!(percent_decode("/%ED%95%9C%EA%B8%80.md"), "/한글.md");
    }

    #[test]
    fn percent_decode_special_chars() {
        assert_eq!(percent_decode("/a%23b%26c"), "/a#b&c");
    }

    #[test]
    fn percent_decode_mixed() {
        assert_eq!(percent_decode("/Users/%ED%99%8D%EA%B8%B8%EB%8F%99/my%20docs/file.md"),
                   "/Users/홍길동/my docs/file.md");
    }

    #[test]
    fn percent_decode_incomplete_sequence() {
        // Incomplete %XX at end — keep characters as-is
        assert_eq!(percent_decode("/file%2"), "/file%2");
    }

    #[test]
    fn percent_decode_invalid_hex() {
        // Invalid hex digits — keep all characters as-is
        assert_eq!(percent_decode("/file%ZZ"), "/file%ZZ");
    }

    #[test]
    fn percent_decode_empty() {
        assert_eq!(percent_decode(""), "");
    }

    // --- hex_val tests ---

    #[test]
    fn hex_val_digits() {
        assert_eq!(hex_val(b'0'), Some(0));
        assert_eq!(hex_val(b'9'), Some(9));
    }

    #[test]
    fn hex_val_lowercase() {
        assert_eq!(hex_val(b'a'), Some(10));
        assert_eq!(hex_val(b'f'), Some(15));
    }

    #[test]
    fn hex_val_uppercase() {
        assert_eq!(hex_val(b'A'), Some(10));
        assert_eq!(hex_val(b'F'), Some(15));
    }

    #[test]
    fn hex_val_invalid() {
        assert_eq!(hex_val(b'g'), None);
        assert_eq!(hex_val(b'Z'), None);
        assert_eq!(hex_val(b' '), None);
    }

    // --- url_to_path additional tests ---

    #[test]
    fn url_to_path_korean_filename() {
        let path = url_to_path("file:///Users/test/%EB%A9%94%EB%AA%A8.md");
        assert_eq!(path, std::path::PathBuf::from("/Users/test/메모.md"));
    }

    #[test]
    fn url_to_path_special_chars() {
        let path = url_to_path("file:///Users/test/file%23name%26.md");
        assert_eq!(path, std::path::PathBuf::from("/Users/test/file#name&.md"));
    }

    #[test]
    fn url_to_path_empty_string() {
        let path = url_to_path("");
        assert_eq!(path, std::path::PathBuf::from(""));
    }

    #[test]
    fn url_to_path_no_path_after_prefix() {
        let path = url_to_path("file://");
        assert_eq!(path, std::path::PathBuf::from(""));
    }

    // --- percent_decode additional tests ---

    #[test]
    fn percent_decode_consecutive_encoded() {
        // %2F%2F → //
        assert_eq!(percent_decode("%2F%2F"), "//");
    }

    #[test]
    fn percent_decode_bare_percent_at_end() {
        assert_eq!(percent_decode("/file%"), "/file%");
    }

    #[test]
    fn percent_decode_all_ascii_encoded() {
        // %41%42%43 → ABC
        assert_eq!(percent_decode("%41%42%43"), "ABC");
    }

    #[test]
    fn percent_decode_mixed_case_hex() {
        // %2a and %2A both → *
        assert_eq!(percent_decode("%2a"), "*");
        assert_eq!(percent_decode("%2A"), "*");
    }

    #[test]
    fn percent_decode_japanese() {
        // テスト in UTF-8: E3 83 86 E3 82 B9 E3 83 88
        assert_eq!(
            percent_decode("%E3%83%86%E3%82%B9%E3%83%88"),
            "テスト"
        );
    }

    #[test]
    fn percent_decode_preserves_plus() {
        // URL path encoding: + stays as +, not space
        assert_eq!(percent_decode("/a+b"), "/a+b");
    }

    // --- PendingFiles / drain_pending / push_pending tests ---

    #[test]
    fn drain_pending_empty() {
        let pf = PendingFiles(Mutex::new(Vec::new()));
        let files = drain_pending(&pf);
        assert!(files.is_empty());
    }

    #[test]
    fn push_and_drain_pending() {
        let pf = PendingFiles(Mutex::new(Vec::new()));
        push_pending(&pf, std::path::PathBuf::from("/tmp/a.md")).unwrap();
        push_pending(&pf, std::path::PathBuf::from("/tmp/b.md")).unwrap();

        let files = drain_pending(&pf);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0], std::path::PathBuf::from("/tmp/a.md"));
        assert_eq!(files[1], std::path::PathBuf::from("/tmp/b.md"));
    }

    #[test]
    fn drain_pending_clears_queue() {
        let pf = PendingFiles(Mutex::new(Vec::new()));
        push_pending(&pf, std::path::PathBuf::from("/tmp/x.md")).unwrap();

        let first = drain_pending(&pf);
        assert_eq!(first.len(), 1);

        let second = drain_pending(&pf);
        assert!(second.is_empty());
    }

    #[test]
    fn push_pending_multiple_then_drain() {
        let pf = PendingFiles(Mutex::new(Vec::new()));
        for i in 0..10 {
            push_pending(&pf, std::path::PathBuf::from(format!("/tmp/{}.md", i))).unwrap();
        }
        let files = drain_pending(&pf);
        assert_eq!(files.len(), 10);
    }

    // --- window state tests ---

    #[test]
    fn window_state_flags_correct() {
        use tauri_plugin_window_state::StateFlags;
        let flags = window_state_flags();
        // Saves position, size, maximized, fullscreen
        assert!(flags.contains(StateFlags::POSITION | StateFlags::SIZE
            | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN));
        // Does not save visible or decorations
        assert!(!flags.contains(StateFlags::VISIBLE));
        assert!(!flags.contains(StateFlags::DECORATIONS));
    }
}

/// Structural invariants for `scripts/bridge.js`.
///
/// bridge.js has no JS-level unit runner in this repo, so these tests guard
/// the critical strings (menu labels, DOM selectors, attachment points) that
/// the tab context-menu feature depends on. If a grep-check fails, the
/// feature is likely broken — either the upstream submodule renamed
/// something, or bridge.js was edited without updating both code paths.
#[cfg(test)]
mod bridge_script_tests {
    use std::path::PathBuf;

    fn bridge_js() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("bridge.js");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
    }

    #[test]
    fn tab_context_menu_defines_all_four_labels() {
        let s = bridge_js();
        assert!(s.contains("'Close Tab'"), "missing 'Close Tab' label");
        assert!(s.contains("'Close Other Tabs'"), "missing 'Close Other Tabs' label");
        assert!(s.contains("'Close Tabs to the Right'"), "missing 'Close Tabs to the Right' label");
        assert!(s.contains("'Close Tabs to the Left'"), "missing 'Close Tabs to the Left' label");
    }

    #[test]
    fn tab_context_menu_attaches_to_desktop_and_mobile_lists() {
        let s = bridge_js();
        assert!(s.contains("attach('tab-list')"), "desktop tab list not attached");
        assert!(s.contains("attach('mobile-tab-list')"), "mobile tab list not attached");
    }

    #[test]
    fn tab_context_menu_targets_both_tab_item_variants() {
        let s = bridge_js();
        // Desktop uses .tab-item; mobile uses .mobile-tab-item — both must match.
        assert!(
            s.contains(".tab-item, .mobile-tab-item"),
            "contextmenu target selector must cover both desktop and mobile"
        );
    }

    #[test]
    fn tab_context_menu_depends_on_data_tab_id_attribute() {
        let s = bridge_js();
        // Every close action resolves the tab by its data-tab-id attribute.
        // If upstream renames it, the menu silently no-ops.
        assert!(
            s.contains("data-tab-id"),
            "data-tab-id attribute lookup missing — upstream may have renamed it"
        );
    }

    #[test]
    fn tab_context_menu_reuses_upstream_delete_action() {
        let s = bridge_js();
        // Tabs[] lives in a closure in the untouched submodule, so we close
        // tabs by clicking the upstream per-tab Delete button. If this
        // selector drifts, every close action silently no-ops.
        assert!(
            s.contains(r#".tab-menu-item[data-action="delete"]"#),
            "delete-button selector missing — upstream renamed or removed it?"
        );
    }

    #[test]
    fn tab_context_menu_dismisses_on_escape_and_outside_click() {
        let s = bridge_js();
        assert!(s.contains("'Escape'"), "Escape handler missing");
        assert!(s.contains("mousedown"), "outside-click handler missing");
        assert!(s.contains("closeMenu"), "closeMenu function missing");
    }

    #[test]
    fn tab_context_menu_uses_stable_css_classes() {
        let s = bridge_js();
        // Referenced from e2e tests — keep these stable.
        assert!(s.contains("'bridge-tab-context-menu'"), "menu CSS class changed");
        assert!(s.contains("'bridge-tab-context-item'"), "item CSS class changed");
    }

    #[test]
    fn tab_context_menu_prevents_default_browser_menu() {
        let s = bridge_js();
        // Without preventDefault the native OS context menu would also appear.
        assert!(
            s.contains("e.preventDefault()"),
            "contextmenu handler must preventDefault"
        );
    }

    // Keyboard shortcut contracts — verified via grep because synthetic
    // KeyboardEvent dispatch does not reach bridge.js's capture listener in
    // the WebKit/Tauri runtime, so e2e coverage is infeasible for Cmd+S and
    // Cmd+O. (Cmd+R is covered end-to-end via its localStorage side effect.)
    // Each shortcut must: match its key, preventDefault, and invoke the
    // registered Tauri command with the expected argument shape.

    #[test]
    fn cmd_s_invokes_save_file_with_path_and_content() {
        let s = bridge_js();
        // The handler opens with this exact `e.key === 's'` check; if
        // someone changes the key literal, this pins the regression.
        assert!(s.contains("e.key === 's'"), "Cmd+S key check missing");
        assert!(
            s.contains("invoke('save_file'"),
            "Cmd+S handler must invoke 'save_file'"
        );
        // Payload shape the Rust command expects (path, not title — title
        // alone is ambiguous when two open files share the same basename).
        assert!(s.contains("path: path"), "save_file payload missing 'path'");
        assert!(s.contains("content: editor.value"), "save_file payload missing 'content'");
    }

    #[test]
    fn cmd_o_invokes_native_open_file() {
        let s = bridge_js();
        assert!(s.contains("e.key === 'o'"), "Cmd+O key check missing");
        assert!(
            s.contains("invoke('native_open_file')"),
            "Cmd+O handler must invoke 'native_open_file'"
        );
    }

    #[test]
    fn cmd_r_triggers_hard_reload() {
        let s = bridge_js();
        assert!(s.contains("e.key === 'r'"), "Cmd+R key check missing");
        // hardReload() preserves globalState + dismissed keys then reloads.
        assert!(s.contains("hardReload()"), "Cmd+R must call hardReload");
    }

    #[test]
    fn shortcut_handlers_prevent_default_and_stop_propagation() {
        let s = bridge_js();
        // The three shortcut blocks each call preventDefault + stopPropagation
        // so the browser's default save/open/reload doesn't run. Grep-count
        // to verify at least three such pairs exist (one per shortcut).
        let pd_count = s.matches("e.preventDefault()").count();
        let sp_count = s.matches("e.stopPropagation()").count();
        assert!(
            pd_count >= 3,
            "expected at least 3 preventDefault() calls across shortcut handlers, found {}",
            pd_count
        );
        assert!(
            sp_count >= 3,
            "expected at least 3 stopPropagation() calls across shortcut handlers, found {}",
            sp_count
        );
    }
}



/// Structural invariants for `scripts/bridge.js` — auto-update check.
///
/// bridge.js has no JS unit runner here, so these grep-style tests guard
/// the critical strings (mode names, localStorage keys, CSS classes,
/// periodic interval) so that accidental drift between bridge.js and its
/// e2e tests / Rust commands is caught at build time.
#[cfg(test)]
mod bridge_update_check_tests {
    use std::path::PathBuf;

    fn bridge_js() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("bridge.js");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
    }

    #[test]
    fn check_for_updates_defines_manual_and_background_modes() {
        let s = bridge_js();
        // Constants guard the canonical mode strings against typos at the
        // definition site.
        assert!(s.contains("MODE_MANUAL = 'manual'"), "MODE_MANUAL constant missing");
        assert!(s.contains("MODE_BACKGROUND = 'background'"), "MODE_BACKGROUND constant missing");
        // Both modes must be reached by at least one call site.
        assert!(s.contains("doCheckForUpdates(MODE_MANUAL)"), "MODE_MANUAL call site missing");
        assert!(s.contains("doCheckForUpdates(MODE_BACKGROUND)"), "MODE_BACKGROUND call site missing");
    }

    #[test]
    fn check_interval_is_24_hours() {
        let s = bridge_js();
        assert!(
            s.contains("24 * 60 * 60 * 1000"),
            "24h interval constant missing or changed"
        );
        assert!(
            s.contains("setInterval") && s.contains("UPDATE_CHECK_INTERVAL_MS"),
            "periodic setInterval on UPDATE_CHECK_INTERVAL_MS missing"
        );
    }

    #[test]
    fn snooze_and_last_check_keys_are_stable() {
        let s = bridge_js();
        // These keys live in user localStorage across versions — renaming
        // silently resets everyone's snooze state.
        assert!(s.contains("'markdown-desk-update-snoozed-version'"),
                "snooze localStorage key changed");
        assert!(s.contains("'markdown-desk-update-last-check'"),
                "last-check localStorage key changed");
    }

    #[test]
    fn banner_exposes_stable_css_classes() {
        let s = bridge_js();
        // Referenced from e2e tests.
        assert!(s.contains("'bridge-update-banner'"), "banner CSS class changed");
    }

    #[test]
    fn banner_has_update_and_close_controls() {
        let s = bridge_js();
        assert!(s.contains("'Update'"), "Update button label missing");
        // Status-bar variant replaced the "Later" button with a single ×
        // close button identified by aria-label "Close update notice".
        assert!(
            s.contains("'Close update notice'"),
            "close button aria-label missing — \
             snooze dismiss path may have regressed"
        );
    }

    #[test]
    fn banner_has_release_notes_link() {
        let s = bridge_js();
        // The What's new link routes through a Tauri command to the
        // GitHub release page. e2e asserts on the href value too, but
        // we pin the invoke name here so a bridge.js rename without a
        // matching command rename is caught by Rust tests.
        assert!(
            s.contains("\"What's new\""),
            "What's new link label missing from banner"
        );
        assert!(
            s.contains("'open_release_page'"),
            "open_release_page invoke missing — link will silently no-op"
        );
    }

    #[test]
    fn title_suffix_invoked_via_rust_command() {
        let s = bridge_js();
        // macOS title bar can only be updated from Rust side; ensure the
        // command name matches what lib.rs registers.
        assert!(
            s.contains("'set_update_title_suffix'"),
            "set_update_title_suffix invoke missing"
        );
    }

    #[test]
    fn startup_check_respects_24h_window() {
        let s = bridge_js();
        // Prevents re-checking the updater server each time the user
        // reopens the app within the same day.
        assert!(
            s.contains("shouldRunBackgroundCheck"),
            "startup gate function missing"
        );
    }

    #[test]
    fn snoozed_version_suppresses_banner() {
        let s = bridge_js();
        // Banner must not appear when localStorage snooze matches the
        // discovered update version.
        assert!(
            s.contains("snoozed !== update.version"),
            "snooze check guard missing or syntactically changed"
        );
    }

    #[test]
    fn update_internals_exposed_for_e2e() {
        let s = bridge_js();
        // The e2e spec drives the banner without a real updater response.
        assert!(
            s.contains("window.__mdDeskUpdateInternals"),
            "test hook window.__mdDeskUpdateInternals missing"
        );
    }

    #[test]
    fn update_internals_wrapped_in_dev_hook_markers() {
        let s = bridge_js();
        // prepare-frontend.sh strips everything between these markers in
        // release builds. If they drift out of sync the production binary
        // will leak the test hook.
        assert!(s.contains("@dev-hook-start"), "@dev-hook-start marker missing");
        assert!(s.contains("@dev-hook-end"), "@dev-hook-end marker missing");
        // The hook must live between the markers.
        let start = s.find("@dev-hook-start").unwrap();
        let end = s.find("@dev-hook-end").unwrap();
        let hook = s.find("window.__mdDeskUpdateInternals").unwrap();
        assert!(start < hook && hook < end,
                "__mdDeskUpdateInternals must be wrapped by @dev-hook markers");
    }

    #[test]
    fn hide_banner_also_clears_title_suffix() {
        let s = bridge_js();
        // Review I-1: banner tear-down and title suffix reset must stay in
        // lockstep. Locate hideUpdateBanner body and check it resets suffix.
        let body_start = s.find("function hideUpdateBanner()")
            .expect("hideUpdateBanner definition missing");
        let body_slice = &s[body_start..];
        let body_end = body_slice.find("\n  }\n")
            .expect("hideUpdateBanner closing brace not found");
        let body = &body_slice[..body_end];
        assert!(
            body.contains("setUpdateTitleSuffix('')"),
            "hideUpdateBanner must reset title suffix so cancel/failure paths don't leave stale title"
        );
    }

    #[test]
    fn show_banner_reapplies_title_suffix_after_teardown() {
        // Regression guard for C-1: hideUpdateBanner() clears the title
        // suffix, and showUpdateBanner() used to call hideUpdateBanner() as a
        // "replace any prior banner" step. When doCheckForUpdates set the
        // suffix *before* calling showUpdateBanner, the nested hide silently
        // wiped it again and the native title stayed "Markdown Desk" — the
        // very cue the feature promised was never shown.
        //
        // Fix: showUpdateBanner must tear down the prior banner DOM without
        // touching the title (removeBannerDom), then (re-)apply the suffix
        // itself so the final invoke is the "set" one.
        let s = bridge_js();
        let body_start = s.find("function showUpdateBanner(version)")
            .expect("showUpdateBanner definition missing");
        let body_slice = &s[body_start..];
        let body_end = body_slice.find("\n  }\n")
            .expect("showUpdateBanner closing brace not found");
        let body = &body_slice[..body_end];

        let teardown_pos = body.find("removeBannerDom()")
            .expect("showUpdateBanner must clear any prior banner via removeBannerDom()");
        let suffix_pos = body.find("setUpdateTitleSuffix(' — Update Available')")
            .expect("showUpdateBanner must (re-)apply title suffix so the background \
                     check flow actually surfaces the cue");
        assert!(
            teardown_pos < suffix_pos,
            "title suffix must be set AFTER removeBannerDom(), so the final invoke \
             is the 'set' and not the 'clear'"
        );
        // The initial teardown at the top of showUpdateBanner must not be
        // hideUpdateBanner() — that would clear the suffix we're about to
        // set. It's OK for nested button handlers to call hideUpdateBanner()
        // (that's a legitimate full dismiss), but nothing above the
        // removeBannerDom() line may touch the title.
        let early_hide = body[..teardown_pos].find("hideUpdateBanner()");
        assert!(
            early_hide.is_none(),
            "showUpdateBanner must not call hideUpdateBanner() before removeBannerDom() \
             — the suffix would be cleared immediately before being set"
        );
    }

    #[test]
    fn do_check_for_updates_does_not_set_title_suffix_directly() {
        // Counterpart to the regression above: title suffix ownership must
        // live in showUpdateBanner so the set/clear timeline is local. If
        // doCheckForUpdates also sets the suffix, we risk the same race
        // creeping back in via a future refactor.
        let s = bridge_js();
        let body_start = s.find("async function doCheckForUpdates(mode)")
            .expect("doCheckForUpdates definition missing");
        let body_slice = &s[body_start..];
        let body_end = body_slice.find("\n  }\n")
            .expect("doCheckForUpdates closing brace not found");
        let body = &body_slice[..body_end];
        assert!(
            !body.contains("setUpdateTitleSuffix(' — Update Available')"),
            "doCheckForUpdates must not set the title suffix directly; \
             showUpdateBanner owns the full teardown→set sequence"
        );
    }

    #[test]
    fn install_success_clears_snooze() {
        let s = bridge_js();
        // Review I-2: the snooze key targets the pre-install version and is
        // stale as soon as the install succeeds. Clear it before relaunch.
        let install = s.find("await update.downloadAndInstall()")
            .expect("downloadAndInstall call missing");
        let after_install = &s[install..];
        let snooze_remove = after_install.find("localStorage.removeItem(UPDATE_SNOOZED_KEY)");
        let catch_block = after_install.find("} catch (dlErr)");
        assert!(snooze_remove.is_some(), "snooze key must be cleared after successful install");
        assert!(
            snooze_remove.unwrap() < catch_block.unwrap_or(usize::MAX),
            "snooze clear must happen inside the success path, before the catch block"
        );
    }

    #[test]
    fn manual_check_routes_updates_to_status_bar_not_dialog() {
        let s = bridge_js();
        // Pre-unification, the MODE_MANUAL branch called
        // `runUpdateInstall(update, { skipConfirm: false })`, which popped a
        // synchronous "New version X is available. Update now?" confirm
        // dialog — a second alert path competing with the status bar.
        // After unification, both modes route to showUpdateBanner; the banner's
        // Update button is the *only* caller of runUpdateInstall and it always
        // passes skipConfirm: true. The literal "skipConfirm: false" returning
        // means the legacy dialog path has regressed.
        assert!(
            !s.contains("skipConfirm: false"),
            "Manual update check must not invoke runUpdateInstall with \
             skipConfirm: false — that reintroduces the dialog we unified \
             into the status bar"
        );
    }

    #[test]
    fn manual_check_keeps_no_update_and_failure_dialogs() {
        let s = bridge_js();
        // Manual check is an explicit user action: the menu click expects
        // feedback. The status bar only renders when *there is* an update,
        // so the no-update and check-failed paths must still surface as
        // dialogs — otherwise pressing the menu yields nothing.
        assert!(
            s.contains("'You are using the latest version.'"),
            "Manual no-update feedback dialog missing"
        );
        assert!(
            s.contains("'Failed to check for updates.'"),
            "Manual check-failed dialog missing"
        );
    }

    #[test]
    fn manual_check_bypasses_snooze() {
        let s = bridge_js();
        // After unification, the snooze key still gates background checks
        // (so we don't repeatedly nag), but a manual menu click bypasses it.
        // Without this, dismissing once and then trying "Check for Updates…"
        // produces no feedback — equivalent to a silent failure.
        // The bridge implements this as `mode === MODE_MANUAL || snoozed !==
        // update.version`. Both halves must remain present.
        assert!(
            s.contains("mode === MODE_MANUAL || snoozed !== update.version"),
            "Manual check must bypass snooze when an update is present \
             (expected `mode === MODE_MANUAL || snoozed !== update.version` \
             guard in doCheckForUpdates)"
        );
    }
}

/// Structural invariants for `scripts/prepare-frontend.sh`.
/// The shell script is the sole gate between dev-only hooks and
/// release bundles; if its guard drifts, release builds leak test surfaces.
#[cfg(test)]
mod prepare_frontend_tests {
    use std::path::PathBuf;

    fn prepare_frontend_sh() -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("prepare-frontend.sh");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
    }

    #[test]
    fn release_builds_strip_dev_hook_block() {
        let s = prepare_frontend_sh();
        // Must check TAURI_ENV_DEBUG and sed-delete the block bounded by
        // the @dev-hook markers when not in debug mode.
        assert!(s.contains("TAURI_ENV_DEBUG"), "TAURI_ENV_DEBUG guard missing");
        assert!(
            s.contains("@dev-hook-start") && s.contains("@dev-hook-end"),
            "dev-hook marker references missing in prepare-frontend.sh"
        );
        assert!(
            s.contains("sed -i '' '/@dev-hook-start/,/@dev-hook-end/d'"),
            "block-delete sed command missing"
        );
    }

    #[test]
    fn debug_gate_semantics_preserved() {
        // Guard against logic inversion: we must strip hooks when the env
        // is NOT "true" (and default-false keeps a bare `bash prepare-…sh`
        // run behaving like release). Flipping the operator to `=` or
        // swapping the default to :-true would silently leak the dev hook
        // into release bundles or vice versa. This test pins the exact
        // comparison so that kind of one-character bug fails loudly.
        let s = prepare_frontend_sh();
        assert!(
            s.contains(r#""${TAURI_ENV_DEBUG:-false}" != "true""#),
            "debug gate must default to 'false' and test inequality with 'true' — \
             a logic inversion would expose the test hook in release builds"
        );
    }
}


/// Regression guard for the Rust side of the updater title suffix.
///
/// `scripts/bridge.js` invokes the Tauri command `set_update_title_suffix`
/// when the updater banner appears or is dismissed, but the Rust command
/// only reaches the webview if it is registered in the `generate_handler!`
/// macro in `lib.rs`. When the handler registration is missing, the
/// Tauri-command function is dead (Rust compiler warns "never used"), and
/// every bridge.js invoke fails silently via the `.catch()` — the user
/// notices nothing, but the title bar update cue is gone.
///
/// This module pins the Rust side of that contract. A sibling test
/// `bridge_update_check_tests::title_suffix_invoked_via_rust_command`
/// pins the JS side; together they catch drift in either direction.
#[cfg(test)]
mod rust_invoke_handler_tests {
    /// Return the production portion of `lib.rs` with `#[cfg(test)]` modules
    /// stripped. Without this, searches would match the test code itself
    /// (including this very comment and assertion strings) and pass even
    /// when the production handler list is missing the command.
    fn production_src() -> &'static str {
        const FULL: &str = include_str!("lib.rs");
        match FULL.find("#[cfg(test)]") {
            Some(idx) => &FULL[..idx],
            None => FULL,
        }
    }

    fn handler_block() -> &'static str {
        let src = production_src();
        let start = src
            .find("tauri::generate_handler![")
            .expect("invoke_handler registration block missing");
        let end = src[start..]
            .find(']')
            .map(|e| start + e)
            .expect("invoke_handler block is not closed");
        // Box::leak to satisfy the &'static str return — fine in tests.
        Box::leak(src[start..=end].to_string().into_boxed_str())
    }

    #[test]
    fn set_update_title_suffix_is_registered_in_invoke_handler() {
        assert!(
            handler_block().contains("set_update_title_suffix"),
            "set_update_title_suffix must be listed in generate_handler![] \
             (bridge.js invokes this command; without registration every \
             call silently fails)"
        );
    }

    #[test]
    fn open_release_page_is_registered_in_invoke_handler() {
        assert!(
            handler_block().contains("open_release_page"),
            "open_release_page must be listed in generate_handler![] \
             (the update status bar's What's new link invokes this; \
             without registration the link silently no-ops)"
        );
    }
}

