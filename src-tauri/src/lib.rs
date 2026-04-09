mod commands;
mod default_app;
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

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
                let Ok(mut guard) = pending.0.lock() else {
                    dbg_log!("[file-assoc] Failed to lock pending files");
                    return;
                };
                let files: Vec<_> = guard.drain(..).collect();
                drop(guard);
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
                        match pending.0.lock() {
                            Ok(mut guard) => guard.push(path),
                            Err(e) => dbg_log!("[file-assoc] Lock error: {}", e),
                        };
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
}
