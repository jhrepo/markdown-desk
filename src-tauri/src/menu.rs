use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

/// JS to invoke the update check function exposed by bridge.js.
pub(crate) const JS_CHECK_UPDATE: &str =
    "if(typeof checkForUpdates==='function')checkForUpdates();";

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

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
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

    let view_menu = SubmenuBuilder::new(app, "View")
        .fullscreen()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .build()
}

pub fn setup_menu_events(app: &tauri::AppHandle) {
    let app_handle = app.clone();
    app.on_menu_event(move |_app, event| {
        if event.id() == "open" {
            dbg_log!("[menu] Open clicked");
            crate::commands::open_file_and_watch(&app_handle);
        } else if event.id() == "check_update" {
            dbg_log!("[menu] Check for Updates clicked");
            if let Some(ww) = app_handle.get_webview_window("main") {
                let _ = ww.eval(JS_CHECK_UPDATE);
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
}
