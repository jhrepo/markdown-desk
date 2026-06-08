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

// Menu item ids — shared by build_menu (which stamps them on the MenuItems) and
// resolve_menu_action (which maps a clicked id back to an action). Defining them
// once means a rename can't desync the two: build_menu would no longer compile
// against a stale literal, and the round-trip tests pin the mapping. A drift
// here is the classic "menu item does nothing when clicked" bug.
pub(crate) const MENU_ID_OPEN: &str = "open";
pub(crate) const MENU_ID_SAVE: &str = "save";
pub(crate) const MENU_ID_CHECK_UPDATE: &str = "check_update";
pub(crate) const MENU_ID_ZOOM_IN: &str = "zoom_in";
pub(crate) const MENU_ID_ZOOM_OUT: &str = "zoom_out";
pub(crate) const MENU_ID_ZOOM_RESET: &str = "zoom_reset";

/// Every custom (id-bearing) menu item build_menu adds. Predefined items
/// (undo/redo/cut/…, about, quit, fullscreen) are handled by the OS and carry
/// no custom id, so they're intentionally excluded.
pub(crate) const MENU_ITEM_IDS: &[&str] = &[
    MENU_ID_OPEN,
    MENU_ID_SAVE,
    MENU_ID_CHECK_UPDATE,
    MENU_ID_ZOOM_IN,
    MENU_ID_ZOOM_OUT,
    MENU_ID_ZOOM_RESET,
];

pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let check_update_item = MenuItemBuilder::with_id(MENU_ID_CHECK_UPDATE, "Check for Updates...")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "Markdown Desk")
        .about(None)
        .separator()
        .item(&check_update_item)
        .separator()
        .quit()
        .build()?;

    let open_item = MenuItemBuilder::with_id(MENU_ID_OPEN, "Open File...")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let save_item = MenuItemBuilder::with_id(MENU_ID_SAVE, "Save")
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
    let zoom_in_item = MenuItemBuilder::with_id(MENU_ID_ZOOM_IN, "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out_item = MenuItemBuilder::with_id(MENU_ID_ZOOM_OUT, "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset_item = MenuItemBuilder::with_id(MENU_ID_ZOOM_RESET, "Actual Size")
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
        MENU_ID_OPEN => MenuAction::Open,
        MENU_ID_SAVE => MenuAction::Save,
        MENU_ID_CHECK_UPDATE => MenuAction::CheckUpdate,
        MENU_ID_ZOOM_IN => MenuAction::ZoomIn,
        MENU_ID_ZOOM_OUT => MenuAction::ZoomOut,
        MENU_ID_ZOOM_RESET => MenuAction::ZoomReset,
        _ => MenuAction::Unknown,
    }
}

/// JS snippet a menu action evals into the webview, or None for actions that
/// don't go through eval. Open opens the native file dialog (Rust side, no
/// eval); Unknown is inert. Extracted from setup_menu_events so the
/// action→snippet routing is unit-testable without a running app — guards
/// against a copy-paste swap (e.g. ZoomIn wired to the zoom-out snippet).
pub(crate) fn menu_action_eval_js(action: &MenuAction) -> Option<&'static str> {
    match action {
        MenuAction::Save => Some(JS_SAVE_FILE),
        MenuAction::CheckUpdate => Some(JS_CHECK_UPDATE),
        MenuAction::ZoomIn => Some(JS_ZOOM_IN),
        MenuAction::ZoomOut => Some(JS_ZOOM_OUT),
        MenuAction::ZoomReset => Some(JS_ZOOM_RESET),
        MenuAction::Open | MenuAction::Unknown => None,
    }
}

pub fn setup_menu_events(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref().to_string();
        let action = resolve_menu_action(&id);
        // Open is the one action that runs Rust-side (native dialog), not eval.
        if matches!(action, MenuAction::Open) {
            dbg_log!("[menu] Open clicked");
            crate::commands::open_file_and_watch(&app_handle);
            return;
        }
        // Everything else routes through a tested action→JS map.
        if let Some(js) = menu_action_eval_js(&action) {
            dbg_log!("[menu] eval action for id: {}", id);
            if let Some(ww) = app_handle.get_webview_window("main") {
                let _ = ww.eval(js);
            }
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

    // --- menu id ↔ action contract ---
    // build_menu() stamps MENU_ID_* on its items; resolve_menu_action() maps
    // them back. They share the constants now, but these tests pin the mapping
    // so a future edit to either side (or a new menu item without a resolve
    // arm) is caught as "clicking this menu item does nothing".

    #[test]
    fn menu_ids_round_trip_to_their_actions() {
        assert!(matches!(resolve_menu_action(MENU_ID_OPEN), MenuAction::Open));
        assert!(matches!(resolve_menu_action(MENU_ID_SAVE), MenuAction::Save));
        assert!(matches!(resolve_menu_action(MENU_ID_CHECK_UPDATE), MenuAction::CheckUpdate));
        assert!(matches!(resolve_menu_action(MENU_ID_ZOOM_IN), MenuAction::ZoomIn));
        assert!(matches!(resolve_menu_action(MENU_ID_ZOOM_OUT), MenuAction::ZoomOut));
        assert!(matches!(resolve_menu_action(MENU_ID_ZOOM_RESET), MenuAction::ZoomReset));
    }

    #[test]
    fn every_custom_menu_id_resolves_to_a_known_action() {
        for id in MENU_ITEM_IDS {
            assert!(
                !matches!(resolve_menu_action(id), MenuAction::Unknown),
                "menu id {id:?} is built but has no resolve_menu_action arm — clicking it would do nothing"
            );
        }
    }

    #[test]
    fn menu_item_ids_are_unique() {
        // A duplicate id would make two menu items dispatch the same action.
        let mut seen = std::collections::HashSet::new();
        for id in MENU_ITEM_IDS {
            assert!(seen.insert(*id), "duplicate menu id: {id:?}");
        }
    }

    // --- menu_action_eval_js (action → JS routing) ---

    #[test]
    fn menu_action_eval_js_routes_each_action_to_its_snippet() {
        assert_eq!(menu_action_eval_js(&MenuAction::Save), Some(JS_SAVE_FILE));
        assert_eq!(menu_action_eval_js(&MenuAction::CheckUpdate), Some(JS_CHECK_UPDATE));
        assert_eq!(menu_action_eval_js(&MenuAction::ZoomIn), Some(JS_ZOOM_IN));
        assert_eq!(menu_action_eval_js(&MenuAction::ZoomOut), Some(JS_ZOOM_OUT));
        assert_eq!(menu_action_eval_js(&MenuAction::ZoomReset), Some(JS_ZOOM_RESET));
    }

    #[test]
    fn menu_action_eval_js_open_and_unknown_have_no_snippet() {
        // Open runs the native dialog (Rust side); Unknown is inert.
        assert_eq!(menu_action_eval_js(&MenuAction::Open), None);
        assert_eq!(menu_action_eval_js(&MenuAction::Unknown), None);
    }

    #[test]
    fn menu_action_eval_js_does_not_swap_zoom_directions() {
        // Guards the copy-paste class: ZoomIn must not eval the zoom-out snippet.
        let zin = menu_action_eval_js(&MenuAction::ZoomIn).unwrap();
        let zout = menu_action_eval_js(&MenuAction::ZoomOut).unwrap();
        assert_ne!(zin, zout);
        assert!(zin.contains(".in()"), "ZoomIn must route to the .in() snippet");
        assert!(zout.contains(".out()"), "ZoomOut must route to the .out() snippet");
    }

    #[test]
    fn every_eval_action_has_a_resolvable_menu_id() {
        // Full loop: each built menu id → action → (for eval actions) a snippet.
        // Open is the documented exception (native dialog, no eval).
        for id in MENU_ITEM_IDS {
            let action = resolve_menu_action(id);
            if matches!(action, MenuAction::Open) {
                assert_eq!(menu_action_eval_js(&action), None);
            } else {
                assert!(
                    menu_action_eval_js(&action).is_some(),
                    "menu id {id:?} resolves to an action with no eval snippet"
                );
            }
        }
    }
}
