use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

/// JS to invoke the update check function exposed by bridge.js.
pub(crate) const JS_CHECK_UPDATE: &str =
    "if(typeof checkForUpdates==='function')checkForUpdates();";

/// JS to save the active tab's content to its original file.
/// Reads the canonical path from the `data-path` attribute that bridge.js
/// stamps on every file-backed tab; same matching key the watcher uses.
pub(crate) const JS_SAVE_FILE: &str =
    "(function(){var a=document.querySelector('#tab-list .tab-item.active');var p=a?a.getAttribute('data-path'):'';var e=document.getElementById('markdown-editor');if(p&&e&&window.__TAURI_INTERNALS__){window.__TAURI_INTERNALS__.invoke('save_file',{path:p,content:e.value})}})();";

/// JS snippets dispatched by View → Zoom menu items. Route through the
/// release-included `window.__mdDeskZoomMenu` so the menu shares the
/// applyZoom path (clamp + localStorage persist + IPC). The `typeof` guard
/// matters because a menu click can race the very first paint where
/// bridge.js's zoom IIFE has not yet executed.
pub(crate) const JS_ZOOM_IN: &str =
    "if(typeof window.__mdDeskZoomMenu==='object')window.__mdDeskZoomMenu.in();";
pub(crate) const JS_ZOOM_OUT: &str =
    "if(typeof window.__mdDeskZoomMenu==='object')window.__mdDeskZoomMenu.out();";
pub(crate) const JS_ZOOM_RESET: &str =
    "if(typeof window.__mdDeskZoomMenu==='object')window.__mdDeskZoomMenu.reset();";

pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let check_update_item = MenuItemBuilder::with_id("check_update", "Check for Updates...")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Markdown Desk")
        .about(None)
        .separator()
        .item(&check_update_item)
        .separator()
        .quit()
        .build()?;

    let open_item = MenuItemBuilder::with_id("open", "Open File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let save_item = MenuItemBuilder::with_id("save", "Save")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .item(&save_item)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // `=` (not `Plus`) so NSMenu renders `⌘=` rather than `⇧⌘=`. The
    // `Plus` token bound to the shifted `+` glyph and pulled `⇧` into
    // the menu shortcut, which conflicted with the comment claim of
    // `⌘+` and with the keystroke users typically associate with the
    // action. bridge.js's handleZoomKey already accepts both `=` and
    // `+`, so a user reaching for Cmd+Shift+= (the keycap path) still
    // zooms in — the change is purely the menu glyph.
    let zoom_in_item = MenuItemBuilder::with_id("zoom_in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out_item = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset_item = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .item(&zoom_reset_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .build()
}

/// Determine the action for a given menu event ID.
pub(crate) enum MenuAction {
    Open,
    Save,
    CheckUpdate,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    Unknown,
}

/// Map a menu event ID string to a MenuAction.
pub(crate) fn resolve_menu_action(id: &str) -> MenuAction {
    match id {
        "open" => MenuAction::Open,
        "save" => MenuAction::Save,
        "check_update" => MenuAction::CheckUpdate,
        "zoom_in" => MenuAction::ZoomIn,
        "zoom_out" => MenuAction::ZoomOut,
        "zoom_reset" => MenuAction::ZoomReset,
        _ => MenuAction::Unknown,
    }
}

pub fn setup_menu_events(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    app.on_menu_event(move |_app, event| {
        match resolve_menu_action(event.id().as_ref()) {
            MenuAction::Open => {
                dbg_log!("[menu] Open clicked");
                crate::commands::open_file_and_watch(&app_handle);
            }
            MenuAction::Save => {
                dbg_log!("[menu] Save clicked");
                if let Some(ww) = app_handle.get_webview_window("main") {
                    let _ = ww.eval(JS_SAVE_FILE);
                }
            }
            MenuAction::CheckUpdate => {
                dbg_log!("[menu] Check for Updates clicked");
                if let Some(ww) = app_handle.get_webview_window("main") {
                    let _ = ww.eval(JS_CHECK_UPDATE);
                }
            }
            MenuAction::ZoomIn => {
                dbg_log!("[menu] Zoom In clicked");
                if let Some(ww) = app_handle.get_webview_window("main") {
                    let _ = ww.eval(JS_ZOOM_IN);
                }
            }
            MenuAction::ZoomOut => {
                dbg_log!("[menu] Zoom Out clicked");
                if let Some(ww) = app_handle.get_webview_window("main") {
                    let _ = ww.eval(JS_ZOOM_OUT);
                }
            }
            MenuAction::ZoomReset => {
                dbg_log!("[menu] Actual Size clicked");
                if let Some(ww) = app_handle.get_webview_window("main") {
                    let _ = ww.eval(JS_ZOOM_RESET);
                }
            }
            MenuAction::Unknown => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_check_update_calls_function() {
        assert!(JS_CHECK_UPDATE.contains("checkForUpdates()"));
    }

    #[test]
    fn js_check_update_has_typeof_guard() {
        // Must guard against function not being defined
        assert!(JS_CHECK_UPDATE.contains("typeof checkForUpdates==='function'"));
    }

    #[test]
    fn js_check_update_is_single_statement() {
        // Should be safe to eval — no unclosed braces or syntax issues
        assert!(!JS_CHECK_UPDATE.contains('\n'));
        assert!(JS_CHECK_UPDATE.ends_with(';'));
    }

    #[test]
    fn js_save_file_reads_active_tab() {
        assert!(JS_SAVE_FILE.contains(".tab-item.active"));
        assert!(JS_SAVE_FILE.contains("data-path"));
        assert!(JS_SAVE_FILE.contains("markdown-editor"));
    }

    #[test]
    fn js_save_file_calls_save_command() {
        assert!(JS_SAVE_FILE.contains("invoke('save_file'"));
    }

    #[test]
    fn js_save_file_is_iife() {
        assert!(JS_SAVE_FILE.starts_with("(function()"));
        assert!(JS_SAVE_FILE.ends_with(";"));
    }

    #[test]
    fn js_save_file_has_tauri_guard() {
        assert!(JS_SAVE_FILE.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn js_save_file_sends_path_and_content() {
        assert!(JS_SAVE_FILE.contains("path:"));
        assert!(JS_SAVE_FILE.contains("content:"));
    }

    #[test]
    fn js_check_update_calls_window_function() {
        // menu calls checkForUpdates() which is set on window by bridge.js
        // This ensures the function name matches what bridge.js exposes
        assert!(JS_CHECK_UPDATE.contains("checkForUpdates"));
        assert!(!JS_CHECK_UPDATE.contains("doCheckForUpdates"));
    }

    // --- resolve_menu_action tests ---

    #[test]
    fn resolve_menu_action_open() {
        assert!(matches!(resolve_menu_action("open"), MenuAction::Open));
    }

    #[test]
    fn resolve_menu_action_save() {
        assert!(matches!(resolve_menu_action("save"), MenuAction::Save));
    }

    #[test]
    fn resolve_menu_action_check_update() {
        assert!(matches!(resolve_menu_action("check_update"), MenuAction::CheckUpdate));
    }

    #[test]
    fn resolve_menu_action_unknown_id() {
        assert!(matches!(resolve_menu_action("unknown"), MenuAction::Unknown));
    }

    #[test]
    fn resolve_menu_action_empty_string() {
        assert!(matches!(resolve_menu_action(""), MenuAction::Unknown));
    }

    #[test]
    fn resolve_menu_action_case_sensitive() {
        // "Open" (capitalized) should not match "open"
        assert!(matches!(resolve_menu_action("Open"), MenuAction::Unknown));
        assert!(matches!(resolve_menu_action("SAVE"), MenuAction::Unknown));
    }

    // --- Zoom menu items (View → Zoom In / Zoom Out / Actual Size) ---
    // Each JS snippet must call into bridge.js's release-included public
    // entry point (`window.__mdDeskZoomMenu`) so the menu route shares the
    // same applyZoom path — clamp, localStorage persist, and IPC call.

    #[test]
    fn js_zoom_in_calls_public_entry_point() {
        assert!(JS_ZOOM_IN.contains("__mdDeskZoomMenu"));
        assert!(JS_ZOOM_IN.contains(".in()"));
    }

    #[test]
    fn js_zoom_out_calls_public_entry_point() {
        assert!(JS_ZOOM_OUT.contains("__mdDeskZoomMenu"));
        assert!(JS_ZOOM_OUT.contains(".out()"));
    }

    #[test]
    fn js_zoom_reset_calls_public_entry_point() {
        assert!(JS_ZOOM_RESET.contains("__mdDeskZoomMenu"));
        assert!(JS_ZOOM_RESET.contains(".reset()"));
    }

    #[test]
    fn js_zoom_snippets_have_typeof_guard() {
        // Menu eval can fire before bridge.js is ready — guard against
        // undefined to avoid a noisy console error on first paint.
        for snippet in [JS_ZOOM_IN, JS_ZOOM_OUT, JS_ZOOM_RESET] {
            assert!(snippet.contains("typeof"), "missing typeof guard: {snippet}");
        }
    }

    #[test]
    fn js_zoom_snippets_are_single_statement() {
        for snippet in [JS_ZOOM_IN, JS_ZOOM_OUT, JS_ZOOM_RESET] {
            assert!(!snippet.contains('\n'));
            assert!(snippet.ends_with(';'));
        }
    }

    #[test]
    fn resolve_menu_action_zoom_in() {
        assert!(matches!(resolve_menu_action("zoom_in"), MenuAction::ZoomIn));
    }

    #[test]
    fn resolve_menu_action_zoom_out() {
        assert!(matches!(resolve_menu_action("zoom_out"), MenuAction::ZoomOut));
    }

    #[test]
    fn resolve_menu_action_zoom_reset() {
        assert!(matches!(resolve_menu_action("zoom_reset"), MenuAction::ZoomReset));
    }
}
