mod commands;
#[macro_use]
mod logger;
mod menu;
mod watcher;

use std::sync::Mutex;
use tauri::Manager;

/// Queue for files opened via file association before the window is ready.
struct PendingFiles(Mutex<Vec<std::path::PathBuf>>);

pub fn run() {
    logger::init();
    dbg_log!("App starting...");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(watcher::WatcherState::new())
        .manage(PendingFiles(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
                commands::native_open_file,
                commands::restore_watcher,
                commands::refresh_active_tab,
                commands::save_file,
                commands::export_text_file,
                commands::export_binary_file,
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
                let files: Vec<_> = pending.0.lock().unwrap().drain(..).collect();
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
                        pending.0.lock().unwrap().push(path);
                    }
                }
            }
        }
    });
}

fn url_to_path(url: &str) -> std::path::PathBuf {
    if let Some(path_str) = url.strip_prefix("file://") {
        // URL decode (e.g., %20 → space)
        let decoded = path_str.replace("%20", " ");
        std::path::PathBuf::from(decoded)
    } else {
        std::path::PathBuf::from(url)
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
}
