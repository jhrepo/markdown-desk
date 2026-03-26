mod commands;
#[macro_use]
mod logger;
mod menu;
mod watcher;

pub fn run() {
    logger::init();
    dbg_log!("App starting...");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(watcher::WatcherState::new())
        .invoke_handler(tauri::generate_handler![
                commands::native_open_file,
                commands::restore_watcher,
                commands::refresh_active_tab,
                commands::save_file
            ])
        .setup(|app| {
            dbg_log!("Setup: building menu");
            let handle = app.handle();
            let menu = menu::build_menu(handle)?;
            app.set_menu(menu)?;
            menu::setup_menu_events(handle);
            dbg_log!("Setup complete");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
