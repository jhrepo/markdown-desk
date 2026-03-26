use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

pub fn build_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Markdown Desk")
        .about(None)
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
        }
    });
}
