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
                commands::reset_watcher,
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

    // Keyboard shortcut contracts. Cmd+R, Cmd+T/W and Cmd+S are ALSO covered
    // end-to-end via observable side effects (tests/e2e/specs/
    // keyboard-shortcuts.spec.js); Cmd+O and Cmd+F stay grep-only — Cmd+O's
    // side effect is a native open dialog webdriver cannot observe or
    // dismiss, and Cmd+F's find bar lives entirely in bridge-injected DOM.
    // Each handler must match its key CAPS-LOCK-TOLERANTLY (Caps Lock
    // reports an uppercase e.key with shiftKey false, so an exact
    // lowercase-literal match silently kills the shortcut — the bug family
    // fixed for Cmd+T/W), preventDefault, and invoke the registered Tauri
    // command with the expected argument shape.

    #[test]
    fn cmd_f_opens_find_bar_caps_lock_tolerant() {
        let s = bridge_js();
        // `!e.shiftKey` keeps every Shift combo unbound — incl. the Caps
        // Lock+Shift corner (lowercase e.key, shiftKey true) the old exact
        // match let through.
        assert!(
            s.contains("!e.shiftKey && e.key.toLowerCase() === 'f'"),
            "Cmd+F key check must lowercase e.key (Caps Lock) and exclude Shift"
        );
        assert!(s.contains("openFindBar()"), "Cmd+F must open the find bar");
    }

    #[test]
    fn cmd_s_invokes_save_file_with_path_and_content() {
        let s = bridge_js();
        // Worst case of the Caps Lock family: an exact === 's' match makes
        // Cmd+S a silent no-op with Caps Lock on — the user believes the
        // file was saved. `!e.shiftKey` keeps every Shift combo unbound,
        // incl. the Caps Lock+Shift corner the old exact match let through.
        assert!(
            s.contains("!e.shiftKey && e.key.toLowerCase() === 's'"),
            "Cmd+S key check must lowercase e.key (Caps Lock) and exclude Shift"
        );
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
        assert!(
            s.contains("!e.shiftKey && e.key.toLowerCase() === 'o'"),
            "Cmd+O key check must lowercase e.key (Caps Lock) and exclude Shift"
        );
        assert!(
            s.contains("invoke('native_open_file')"),
            "Cmd+O handler must invoke 'native_open_file'"
        );
    }

    #[test]
    fn cmd_r_triggers_hard_reload() {
        let s = bridge_js();
        // Shift is NOT excluded here: Cmd+Shift+R is the conventional
        // hard-reload alias the handler comment promises (with the old exact
        // === 'r' match Shift produced 'R' and the alias never worked), and
        // the same lowercasing fixes Caps Lock.
        assert!(
            s.contains("e.key.toLowerCase() === 'r'"),
            "Cmd+R key check must lowercase e.key (Caps Lock + Cmd+Shift+R)"
        );
        // Negative pin for the alias: the positive substring above would
        // still match if someone re-added a Shift exclusion, silently
        // killing Cmd+Shift+R again.
        assert!(
            !s.contains("!e.shiftKey && e.key.toLowerCase() === 'r'"),
            "Cmd+R must NOT exclude Shift — Cmd+Shift+R is a supported hard-reload alias"
        );
        // hardReload() preserves globalState + dismissed keys then reloads.
        assert!(s.contains("hardReload()"), "Cmd+R must call hardReload");
    }

    #[test]
    fn foreground_resync_coalesces_visibility_and_focus() {
        // Un-minimizing the window fires `visibilitychange` (hidden→visible)
        // AND `window` focus back-to-back. Both re-sync paths used to call
        // refreshActiveFromDisk directly, doubling the disk read + eval on
        // every restore (harmless thanks to js_update_tab's unchanged no-op,
        // but pure I/O waste in the known read-amplification family). Both
        // listeners must route through the queued wrapper, which collapses
        // same-tick duplicates behind a flag.
        let s = bridge_js();
        let body = slice_fn_body(&s, "queueRefreshActiveFromDisk");
        assert!(
            body.contains("refreshQueued"),
            "queueRefreshActiveFromDisk must gate on the refreshQueued flag"
        );
        assert!(
            body.contains("refreshActiveFromDisk()"),
            "queued wrapper must invoke the real refresh"
        );
        assert!(
            s.contains("window.addEventListener('focus', queueRefreshActiveFromDisk)"),
            "focus listener must use the coalescing wrapper"
        );
        assert!(
            !s.contains("window.addEventListener('focus', refreshActiveFromDisk)"),
            "focus listener bypasses the coalescing wrapper (double-read regression)"
        );
    }

    #[test]
    fn cmd_t_and_w_forward_to_submodule_web_bindings() {
        // Markdown-Viewer 3.7.3 gates its Ctrl/Cmd+T (new tab) and Ctrl/Cmd+W
        // (close tab) bindings behind `typeof Neutralino !== 'undefined'` —
        // upstream's own Neutralino desktop shell. The Tauri WebView has no
        // Neutralino global, so those bindings are permanently dead here.
        // A `window.Neutralino = {}` stub is NOT an option: script.js also
        // CALLS Neutralino APIs (os.showSaveDialog, filesystem.*) on other
        // paths, so a bare stub trades dead shortcuts for runtime TypeErrors.
        // Instead bridge.js intercepts Cmd+T/W and re-dispatches them as the
        // submodule's ungated WEB bindings (Alt+Shift+T / Alt+Shift+W).
        // The matching upstream pin lives in
        // tests/unit/submodule-contract.test.mjs (gate + web bindings exist).
        let s = bridge_js();
        // Caps Lock yields e.key 'T'/'W' (uppercase, shiftKey false), so the
        // shim must compare the LOWERCASED key — an exact === 't' match left
        // the shortcuts dead under Caps Lock. Shift/Alt chords must stay
        // excluded: Cmd+Shift+T is NOT new-tab (browser convention reserves
        // it for reopen-closed-tab), and the synthetic re-dispatch itself
        // carries Alt+Shift, so the exclusion also makes recursion impossible.
        assert!(
            s.contains("e.key.toLowerCase()"),
            "Cmd+T/W shim must lowercase e.key (Caps Lock regression)"
        );
        assert!(
            s.contains("e.shiftKey || e.altKey"),
            "Cmd+T/W shim must exclude Shift/Alt chords"
        );
        assert!(s.contains("key === 't'"), "Cmd+T key check missing");
        assert!(s.contains("key === 'w'"), "Cmd+W key check missing");
        let body = slice_fn_body(&s, "bridgeForwardDesktopShortcut");
        assert!(
            body.contains("new KeyboardEvent('keydown'"),
            "shim must re-dispatch a synthetic keydown the submodule handles"
        );
        assert!(
            body.contains("altKey: true") && body.contains("shiftKey: true"),
            "shim must target the submodule's Alt+Shift web bindings"
        );
    }

    #[test]
    fn hard_reload_resets_rust_watcher_state() {
        let s = bridge_js();
        // Reset button + Cmd+R both route through hardReload(). Clearing
        // localStorage drops the JS-side watched-paths list, but the Rust
        // WatcherState survives the webview reload — location.reload()
        // reloads the page, it does not restart the process. Without the
        // reset_watcher IPC, JS (empty list) and Rust (still watching the
        // pre-Reset files) diverge and FSEvents watches accumulate across
        // Resets within a session. hardReload must clear the Rust side too.
        let body = slice_fn_body(&s, "hardReload");
        assert!(
            body.contains("invoke('reset_watcher')"),
            "hardReload must invoke 'reset_watcher' to clear Rust WatcherState"
        );
        // then(reload, reload) covers resolve AND reject, but a promise that
        // never settles would strand the page mid-Reset with the tab-session
        // setItem suppression still installed. No real trigger is known
        // (Tauri rejects even unregistered commands), so this is a cheap
        // defensive fallback: reload regardless after a timeout.
        assert!(
            body.contains("setTimeout(") && body.contains("clearTimeout("),
            "hardReload must reload via timeout fallback if reset_watcher never settles"
        );
    }

    // --- Live-reload stamping race guards ------------------------------
    // These pin the cold-start fix from this change. Without them,
    // bridgeStampTabPath's `firstSeen` flag could be deleted by a future
    // edit (it's terse), the live-reload race would silently come back,
    // and the e2e regression would only surface from a fresh user session.

    #[test]
    fn stamp_tab_path_gates_queue_on_first_seen_only() {
        let s = bridge_js();
        // The flag itself.
        assert!(s.contains("firstSeen"), "firstSeen guard missing in bridgeStampTabPath");
        // And the seen-id tracker that backs it.
        assert!(s.contains("seenTabIds"), "seenTabIds tracker missing");
    }

    // Extract the body of a top-level `function NAME() { … }` from
    // bridge.js so single-function invariants (forEach order, branch
    // structure) can be asserted without matching unrelated text elsewhere
    // in the file. `pub(super)` so other test modules in this file (e.g.
    // bridge_update_check_tests) can share the same robust slicer.
    //
    // The brace-depth count skips characters inside string literals,
    // template literals, and line/block comments so a future edit that
    // adds `'{}'.repeat(...)`, `/^\{$/`, `` `${x}` ``, or just a comment
    // line like `// closing }` can't desync the slicer. Without this
    // guard the count would silently land mid-token and the assertions
    // below would either false-fail or — worse — false-pass against an
    // empty slice.
    pub(super) fn slice_fn_body<'a>(s: &'a str, name: &str) -> &'a str {
        let header = format!("function {}(", name);
        let start = s
            .find(&header)
            .unwrap_or_else(|| panic!("function {} not found in bridge.js", name));
        let open_rel = s[start..]
            .find('{')
            .unwrap_or_else(|| panic!("function {} body open brace missing", name));
        let open = start + open_rel + 1;
        let bytes = s.as_bytes();

        #[derive(PartialEq)]
        enum Mode {
            Code,
            Single,
            Double,
            Tmpl,
            Line,
            Block,
        }

        let mut mode = Mode::Code;
        let mut depth: usize = 1;
        let mut i = open;
        while i < bytes.len() && depth > 0 {
            let c = bytes[i];
            match mode {
                Mode::Code => {
                    // Comment openers take priority over the division
                    // operator — bridge.js has no regex-literal slot
                    // inside any function we slice, so we can treat `/`
                    // as comment-only without false positives.
                    if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                        mode = Mode::Line;
                        i += 2;
                        continue;
                    }
                    if c == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                        mode = Mode::Block;
                        i += 2;
                        continue;
                    }
                    if c == b'\'' {
                        mode = Mode::Single;
                    } else if c == b'"' {
                        mode = Mode::Double;
                    } else if c == b'`' {
                        mode = Mode::Tmpl;
                    } else if c == b'{' {
                        depth += 1;
                    } else if c == b'}' {
                        depth -= 1;
                    }
                }
                Mode::Single => {
                    if c == b'\\' {
                        i += 2;
                        continue;
                    }
                    if c == b'\'' {
                        mode = Mode::Code;
                    }
                }
                Mode::Double => {
                    if c == b'\\' {
                        i += 2;
                        continue;
                    }
                    if c == b'"' {
                        mode = Mode::Code;
                    }
                }
                Mode::Tmpl => {
                    // We don't model `${ … }` interpolation: bridge.js
                    // doesn't use template literals inside any sliced
                    // body today. If that changes, the assertion below
                    // will trip first and the slicer can be upgraded.
                    if c == b'\\' {
                        i += 2;
                        continue;
                    }
                    if c == b'`' {
                        mode = Mode::Code;
                    }
                }
                Mode::Line => {
                    if c == b'\n' {
                        mode = Mode::Code;
                    }
                }
                Mode::Block => {
                    if c == b'*' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                        mode = Mode::Code;
                        i += 2;
                        continue;
                    }
                }
            }
            i += 1;
        }
        assert!(
            depth == 0,
            "function {}: brace depth never reached zero — unbalanced braces or unterminated string/comment",
            name
        );
        &s[open..i - 1]
    }

    #[test]
    fn restamp_all_tabs_marks_pre_existing_tabs_seen_first() {
        let s = bridge_js();
        // bridgeRestampAllTabs must register every existing id in
        // seenTabIds BEFORE running bridgeStampTabPath on them, otherwise
        // a queued path could leak into the Welcome tab during a host
        // re-render that happens to run before MO is installed. A future
        // refactor that fuses the two forEach passes into one would silently
        // resurrect the race (the marking would run interleaved with
        // stamping instead of strictly before it).
        let body = slice_fn_body(&s, "bridgeRestampAllTabs");
        let count = body.matches(".forEach(").count();
        assert!(
            count >= 2,
            "bridgeRestampAllTabs must use two forEach passes (mark, then stamp); found {}",
            count
        );
        let first_idx = body.find(".forEach(").expect("first forEach");
        let second_off = body[first_idx + 1..]
            .find(".forEach(")
            .expect("second forEach")
            + first_idx
            + 1;
        let first_pass = &body[..second_off];
        let second_pass = &body[second_off..];
        assert!(
            first_pass.contains("seenTabIds[id] = 1"),
            "first forEach must mark seenTabIds before the stamping pass"
        );
        assert!(
            second_pass.contains("bridgeStampTabPath"),
            "second forEach must invoke bridgeStampTabPath"
        );
    }

    #[test]
    fn gc_tab_paths_only_drops_stale_ids() {
        let s = bridge_js();
        // The auto-recovery basename heuristic was removed: a user-driven
        // tab rename (Markdown-Viewer's renameTab() overwrites tab.title)
        // would otherwise trip the title/path mismatch branch and the
        // sidecar entry would be permanently dropped, breaking live-reload
        // for that tab until it's closed and re-opened. Stale-id GC alone
        // is enough — leaked entries from closed tabs still get pruned.
        let body = slice_fn_body(&s, "bridgeGcTabPaths");
        assert!(
            !body.contains("titleBase") && !body.contains("pathBase"),
            "bridgeGcTabPaths must not compare title/path basenames — user renames must not poison the sidecar"
        );
        // The one and only delete must be guarded by the stale-id check.
        // Whitespace-strip both sides so a future formatter inserting
        // spaces (`delete map [id]`, `delete map[ id ]`) doesn't turn the
        // grep into a silent false-negative — the invariant is about the
        // operator + key shape, not column alignment.
        let normalized: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let delete_count = normalized.matches("deletemap[id]").count();
        assert_eq!(
            delete_count, 1,
            "bridgeGcTabPaths must delete entries exactly once (the stale-id branch); found {}",
            delete_count
        );
        assert!(
            body.contains("if (!t)") || body.contains("if (!byId[id])"),
            "bridgeGcTabPaths must gate the delete on a stale-id check"
        );
    }

    // Mirror prepare-frontend.sh's sed: strip every line from
    // `@dev-hook-start` through the matching `@dev-hook-end` inclusive.
    // Generic over file content so the same contract can be re-checked
    // against bridge.js, bridge-helpers.js, and toc.js — every script the
    // build pipeline runs the sed on.
    //
    // Enforces stack-strict marker pairing: a nested `@dev-hook-start`
    // inside an already-open block, or an `@dev-hook-end` without a
    // matching opener, panics. sed's address range silently swallows
    // those mistakes (closing on the first `@dev-hook-end` regardless
    // of nesting) and the surrounding dev block would either leak its
    // tail into release or strip live code. Panicking here turns that
    // into a test failure instead.
    fn release_strip(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        let mut skipping = false;
        for (line_no, line) in raw.lines().enumerate() {
            if line.contains("@dev-hook-start") {
                assert!(
                    !skipping,
                    "nested @dev-hook-start at line {} — sed would close on the inner end and leak the outer block's tail",
                    line_no + 1
                );
                skipping = true;
                continue;
            }
            if line.contains("@dev-hook-end") {
                assert!(
                    skipping,
                    "@dev-hook-end at line {} without a matching @dev-hook-start — orphan marker",
                    line_no + 1
                );
                skipping = false;
                continue;
            }
            if !skipping {
                out.push_str(line);
                out.push('\n');
            }
        }
        assert!(
            !skipping,
            "@dev-hook-start opened but never closed — sed would strip to EOF"
        );
        out
    }

    // Discover every dev-only namespace token in the raw source so the
    // strip assertion below is self-updating: a new `__mdDesk*Internals`
    // gets picked up automatically as long as it lives inside a dev-hook
    // block. Constrained to the `__mdDesk` project prefix so unrelated
    // PascalCase `*Internals` identifiers (e.g. a future dependency's
    // `WebSocketInternals`) don't trigger false-fails — the broader
    // `contains("Internals")` check used to do exactly that.
    fn extract_dev_namespaces(raw: &str) -> Vec<String> {
        let bytes = raw.as_bytes();
        let mut out = Vec::new();
        let needle = "__mdDesk";
        let mut start = 0;
        while let Some(rel) = raw[start..].find(needle) {
            let idx = start + rel;
            let mut end = idx + needle.len();
            while end < bytes.len() {
                let c = bytes[end];
                if c.is_ascii_alphanumeric() || c == b'_' {
                    end += 1;
                } else {
                    break;
                }
            }
            let tok = &raw[idx..end];
            if tok.ends_with("Internals") {
                let s = tok.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
            start = end.max(idx + 1);
        }
        out
    }

    fn read_script(name: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
    }

    // Every script that ships into dist/ goes through the same sed strip.
    // Keep this list in sync with prepare-frontend.sh's glob — the
    // `prepare_frontend_sh_strips_every_bridge_owned_script` test below
    // catches drift.
    const BRIDGE_OWNED_SCRIPTS: &[&str] = &["bridge.js", "bridge-helpers.js", "toc.js"];

    #[test]
    fn dev_hook_markers_balance_in_every_bridge_owned_script() {
        // A structural invariant: every `@dev-hook-start` must be paired
        // with an `@dev-hook-end`. An unbalanced count means sed's
        // address range would either swallow live code (start with no
        // end) or leave a dev block in the release (end without start).
        // Checked on the raw source so a regression shows up before the
        // strip runs.
        for name in BRIDGE_OWNED_SCRIPTS {
            let raw = read_script(name);
            let starts = raw.matches("@dev-hook-start").count();
            let ends = raw.matches("@dev-hook-end").count();
            assert_eq!(
                starts, ends,
                "{}: @dev-hook-start ({}) and @dev-hook-end ({}) must pair",
                name, starts, ends
            );
        }
    }

    #[test]
    fn release_strip_removes_dev_only_internals_from_every_bridge_owned_script() {
        // The original guard covered bridge.js only. toc.js also defines a
        // `__mdDeskTocInternals` surface inside a dev-hook block, so if a
        // future edit drops toc.js from the sed glob or corrupts its
        // markers the namespace would silently leak into the release
        // WebView. Iterate over every bridge-owned script to keep the
        // invariant uniform.
        for name in BRIDGE_OWNED_SCRIPTS {
            let raw = read_script(name);
            let stripped = release_strip(&raw);
            assert!(
                !stripped.contains("@dev-hook-start"),
                "{}: @dev-hook-start marker leaked into release output",
                name
            );
            assert!(
                !stripped.contains("@dev-hook-end"),
                "{}: @dev-hook-end marker leaked into release output",
                name
            );
            // Every dev-only namespace is `__mdDesk*Internals`
            // (__mdDeskUpdateInternals, __mdDeskZoomInternals,
            // __mdDeskViewModeInternals, __mdDeskTocInternals). Extract
            // the actual identifiers from the raw source so the check
            // stays narrow — a third-party `WebSocketInternals` or
            // similar identifier doesn't accidentally fail the test.
            // Tauri's UPPER_SNAKE __TAURI_INTERNALS__ is unaffected (it
            // lacks the `__mdDesk` prefix). If a script defines no
            // namespaces at all (e.g. bridge-helpers.js), the loop is
            // a no-op and the marker assertions above are the gate.
            for ns in extract_dev_namespaces(&raw) {
                assert!(
                    !stripped.contains(ns.as_str()),
                    "{}: dev namespace {} leaked into release output — dev-hook strip is broken",
                    name,
                    ns
                );
            }
        }
    }

    #[test]
    fn prepare_frontend_sh_strips_every_bridge_owned_script() {
        // Drift guard: if a new bridge-owned script lands and the sed
        // glob isn't updated, the strip silently skips it and any
        // namespace it defines leaks. A whole-file `contains(name)`
        // assertion isn't enough — every bridge-owned filename shows up
        // elsewhere in the script (the unconditional `cp` lines, the
        // version-injection `sed`, the `<script src=...>` injector). A
        // future PR that drops just the strip loop would still pass.
        // Anchor on the actual loop line + sed line instead.
        let raw = read_script("prepare-frontend.sh");
        let strip_loop = raw
            .lines()
            .find(|l| l.trim_start().starts_with("for f in") && l.contains("bridge.js"))
            .expect("prepare-frontend.sh dev-hook strip `for f in …` loop missing");
        for name in BRIDGE_OWNED_SCRIPTS {
            assert!(
                strip_loop.contains(name),
                "prepare-frontend.sh strip loop missing {} (loop line: {:?})",
                name,
                strip_loop
            );
        }
        // The sed itself must still wrap the canonical sentinel range —
        // a rename on one side (markers in JS) but not the other (sed
        // pattern here) breaks the strip without any prior test noticing.
        let sed_line = raw.lines().find(|l| {
            l.contains("sed") && l.contains("@dev-hook-start") && l.contains("@dev-hook-end")
        });
        assert!(
            sed_line.is_some(),
            "prepare-frontend.sh sed line on the @dev-hook sentinel range missing"
        );
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
    fn release_tag_url_prefix_matches_between_js_and_rust() {
        // Both bridge-helpers.js (banner href) and commands.rs
        // (open_release_page IPC) hardcode the same GitHub release-tag
        // URL prefix. Owner or repo rename + single-side update would
        // make the banner click open a different page than the deep
        // link reports. Tie the two together: if the Rust constant
        // changes, this assertion forces the JS literal to follow.
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("bridge-helpers.js");
        let helpers = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));
        assert!(
            helpers.contains(crate::commands::RELEASE_TAG_URL_PREFIX),
            "bridge-helpers.js RELEASE_TAG_URL_PREFIX literal drifted from commands.rs constant"
        );
    }

    #[test]
    fn show_update_banner_fails_closed_before_constructing_dom() {
        // The helpers-absent / unsafe-token rejection branches must run
        // BEFORE any DOM construction so a refactor that reorders the
        // function body can't accidentally splice a tainted value into
        // the banner. Function-body slicing keeps the assertion local —
        // matching unrelated `document.createElement` calls elsewhere
        // in bridge.js would otherwise mask a regression here.
        let s = bridge_js();
        let body = super::bridge_script_tests::slice_fn_body(&s, "showUpdateBanner");

        // Semantic matches rather than exact source strings: a benign
        // refactor that swaps `if (!helpers || !helpers.buildReleaseUrl)`
        // for `if (helpers == null || ...)` should not register as a
        // "branch deleted" — the invariant is "helpers gets null-checked
        // before DOM construction," not the literal punctuation of the
        // check. `!helpers` substring catches the negation regardless of
        // surrounding operator order, and the unsafe-token rejection
        // gates `releaseUrl` falsiness the same way.
        let null_check_idx = body
            .find("!helpers")
            .expect("helpers null-check (`!helpers`) missing — fail-closed branch deleted");
        let unsafe_token_idx = body
            .find("!releaseUrl")
            .expect("unsafe-token rejection (`!releaseUrl`) missing — fail-closed branch deleted");
        let first_dom_idx = body
            .find("document.createElement")
            .expect("banner construction missing");
        assert!(
            null_check_idx < first_dom_idx,
            "helpers null-check must precede banner DOM construction (was {} >= {})",
            null_check_idx, first_dom_idx
        );
        assert!(
            unsafe_token_idx < first_dom_idx,
            "unsafe-token rejection must precede banner DOM construction (was {} >= {})",
            unsafe_token_idx, first_dom_idx
        );

        // Defense-in-depth: the click handler that invokes
        // `open_release_page` must re-validate the token *inside the
        // handler* — a re-check living outside the lambda would let a
        // refactor that reaches the IPC through a different code path
        // bypass the gate. Anchor the slice on both ends so the check
        // has to land between the addEventListener('click', ...) opener
        // and the open_release_page invoke.
        let click_open_idx = body
            .find("releaseLink.addEventListener('click'")
            .expect("What's new click handler missing");
        let invoke_idx = body
            .find("'open_release_page'")
            .expect("open_release_page invoke missing");
        let check_idx = body
            .find("isSafeVersionToken(version)")
            .expect("click handler must re-check isSafeVersionToken before the IPC dispatch");
        assert!(
            click_open_idx < check_idx && check_idx < invoke_idx,
            "isSafeVersionToken re-check must sit inside the click handler — between addEventListener('click') ({}) and the open_release_page invoke ({}); found at {}",
            click_open_idx, invoke_idx, check_idx
        );
    }

    #[test]
    fn banner_validates_version_token_client_side() {
        let s = bridge_js();
        // Defense-in-depth: outside Tauri (dev server / e2e Playwright) the
        // href is followed verbatim, so the same whitelist Rust enforces
        // at the IPC boundary must run on the JS side before the banner
        // gets built. The check is now centralized in buildReleaseUrl,
        // which internally calls isSafeVersionToken and returns null on
        // rejection — the banner refuses to render when the URL is null.
        assert!(
            s.contains("buildReleaseUrl"),
            "showUpdateBanner must build the release URL via buildReleaseUrl (which validates with isSafeVersionToken)"
        );
        // And the null-check on the result — without it, an unsafe token
        // would still let the banner render with a null href.
        assert!(
            s.contains("if (!releaseUrl)"),
            "showUpdateBanner must abort when buildReleaseUrl rejects the version token"
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

    #[test]
    fn reset_watcher_is_registered_in_invoke_handler() {
        assert!(
            handler_block().contains("reset_watcher"),
            "reset_watcher must be listed in generate_handler![] \
             (the cold-start e2e invokes it in beforeEach to clear accumulated \
             watches; without registration the call silently fails and the \
             spec goes flaky again)"
        );
    }
}

