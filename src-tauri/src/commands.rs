use crate::dbg_log;
use crate::watcher::WatcherState;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// Tauri IPC command — called from JS (Cmd+O shortcut or file-input override)
#[tauri::command]
pub fn native_open_file(app: tauri::AppHandle) {
    dbg_log!("[cmd] native_open_file called");
    open_file_and_watch(&app);
}

/// Open file(s) via native dialog, inject as new tabs via file-input change event, start watching.
pub fn open_file_and_watch(app: &tauri::AppHandle) {
    let app_handle = app.clone();

    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_files(move |file_paths| {
            let Some(fps) = file_paths else { return };

            for fp in fps {
                let path = match fp.into_path() {
                    Ok(pb) => pb,
                    Err(e) => {
                        dbg_log!("[open] FilePath error: {}", e);
                        continue;
                    }
                };

                match read_and_prepare_file(&path) {
                    Ok((content, filename)) => {
                        dbg_log!("[open] {} bytes from {}", content.len(), filename);
                        open_in_new_tab(&app_handle, &content, &filename);

                        let state = app_handle.state::<WatcherState>();
                        match crate::watcher::add_file(&app_handle, &state, path.clone()) {
                            Ok(_) => {
                                dbg_log!("[open] File added to watch list");
                                persist_watched_path(&app_handle, &path);
                            }
                            Err(e) => dbg_log!("[open] Watcher error: {}", e),
                        }
                    }
                    Err(e) => dbg_log!("[open] {}", e),
                }
            }
        });
}

/// Open a file directly by path (used by file association, no dialog).
pub fn open_file_directly(app: &tauri::AppHandle, path: std::path::PathBuf) {
    dbg_log!("[file-assoc] Opening: {}", path.display());

    match read_and_prepare_file(&path) {
        Ok((content, filename)) => {
            open_in_new_tab(app, &content, &filename);

            let state = app.state::<WatcherState>();
            match crate::watcher::add_file(app, &state, path.clone()) {
                Ok(_) => {
                    dbg_log!("[file-assoc] File added to watch list");
                    persist_watched_path(app, &path);
                }
                Err(e) => dbg_log!("[file-assoc] Watcher error: {}", e),
            }
        }
        Err(e) => dbg_log!("[file-assoc] {}", e),
    }
}

/// Read a file and return its (content, filename) pair.
pub(crate) fn read_and_prepare_file(path: &std::path::Path) -> Result<(String, String), String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Read error: {}", e))?;
    let filename = filename_from_path(path);
    Ok((content, filename))
}

/// Read multiple files and return a vec of results, one per path (order preserved).
#[cfg(test)]
pub(crate) fn read_and_prepare_files(
    paths: &[std::path::PathBuf],
) -> Vec<Result<(String, String), String>> {
    paths.iter().map(|p| read_and_prepare_file(p)).collect()
}

/// Extract the filename from a path as a String.
pub(crate) fn filename_from_path(path: &std::path::Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

/// Generate JS to open content in a new tab via synthetic file-input change event.
pub(crate) fn js_new_tab(content: &str, filename: &str) -> String {
    let js_content = escape_js(content);
    let js_filename = escape_js(filename);

    format!(
        r#"(function() {{
            var fileInput = document.getElementById('file-input');
            if (!fileInput) return;
            var blob = new Blob([`{}`], {{ type: 'text/markdown' }});
            var file = new File([blob], `{}`, {{ type: 'text/markdown' }});
            var dt = new DataTransfer();
            dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', {{ bubbles: true }}));
            setTimeout(function() {{
                var editor = document.getElementById('markdown-editor');
                var preview = document.getElementById('preview');
                if (editor) {{ editor.scrollTop = 0; }}
                if (preview) {{ preview.scrollTop = 0; }}
                window.scrollTo(0, 0);
            }}, 100);
        }})()"#,
        js_content, js_filename
    )
}

/// Generate JS to update the active tab if it matches the given filename.
/// Checks the DOM tab bar for the active tab's title to determine if it matches.
pub(crate) fn js_update_tab(content: &str, filename: &str) -> String {
    let js_content = escape_js(content);
    let js_filename = escape_js(filename);

    format!(
        r#"(function() {{
            var filename = `{}`;
            var titleMatch = filename.replace(/\.md$/i, '');
            var activeEl = document.querySelector('#tab-list .tab-item.active .tab-title');
            var activeTitle = activeEl ? activeEl.textContent.trim() : '';
            if (activeTitle !== titleMatch && activeTitle !== filename) return;
            var editor = document.getElementById('markdown-editor');
            if (editor) {{
                var newContent = `{}`;
                if (editor.value === newContent) return;
                editor.value = newContent;
                editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
                setTimeout(function() {{
                    editor.scrollTop = 0;
                    var preview = document.getElementById('preview');
                    if (preview) {{ preview.scrollTop = 0; }}
                    window.scrollTo(0, 0);
                }}, 100);
            }}
        }})()"#,
        js_filename, js_content
    )
}

fn open_in_new_tab(app: &tauri::AppHandle, content: &str, filename: &str) {
    if let Some(ww) = app.get_webview_window("main") {
        let js = js_new_tab(content, filename);
        match ww.eval(&js) {
            Ok(_) => dbg_log!("[tab] New tab triggered: {}", filename),
            Err(e) => dbg_log!("[tab] Failed: {}", e),
        }
    }
}

/// Update content in matching tabs (used by file watcher for live reload)
pub fn update_current_tab(app: &tauri::AppHandle, content: &str, filename: &str) {
    if let Some(ww) = app.get_webview_window("main") {
        let js = js_update_tab(content, filename);
        match ww.eval(&js) {
            Ok(_) => dbg_log!("[update] OK: {}", filename),
            Err(e) => dbg_log!("[update] Failed: {}", e),
        }
    }
}

/// Generate JS to add a file path to the watched paths list in localStorage.
pub(crate) fn js_add_watched_path(path: &str) -> String {
    let escaped = escape_js(path);
    format!(
        r#"(function(){{var k='markdown-desk-watched-paths';var arr=JSON.parse(localStorage.getItem(k)||'[]');var p=`{}`;if(arr.indexOf(p)<0)arr.push(p);localStorage.setItem(k,JSON.stringify(arr))}})()"#,
        escaped
    )
}

fn persist_watched_path(app: &tauri::AppHandle, path: &std::path::Path) {
    if let Some(ww) = app.get_webview_window("main") {
        let js = js_add_watched_path(&path.to_string_lossy());
        match ww.eval(&js) {
            Ok(_) => dbg_log!("[persist] Watched path stored: {}", path.display()),
            Err(e) => dbg_log!("[persist] Failed to store watched path: {}", e),
        }
    }
}

/// Validate a path string for watcher restoration. Returns Some(PathBuf) if the file exists.
pub(crate) fn validate_restore_path(path: &str) -> Option<std::path::PathBuf> {
    let path_buf = std::path::PathBuf::from(path);
    if path_buf.exists() { Some(path_buf) } else { None }
}

/// Tauri IPC command — called from bridge.js on app restart to restore file watching.
#[tauri::command]
pub fn restore_watcher(app: tauri::AppHandle, path: String) {
    let Some(path_buf) = validate_restore_path(&path) else {
        dbg_log!("[restore] File no longer exists: {}", path);
        return;
    };
    let state = app.state::<WatcherState>();
    match crate::watcher::add_file(&app, &state, path_buf) {
        Ok(_) => dbg_log!("[restore] Watcher restored for: {}", path),
        Err(e) => dbg_log!("[restore] Watcher restore failed: {}", e),
    }
}

/// Resolve a tab title to its file content. Returns (content, filename) on success.
pub(crate) fn resolve_and_read_tab(
    state: &WatcherState,
    title: &str,
) -> Option<Result<(String, String), String>> {
    let path = crate::watcher::path_for_title(state, title)?;
    Some(read_and_prepare_file(&path))
}

/// Tauri IPC command — called from bridge.js on tab switch.
/// Reads the file matching the given tab title and updates the tab.
#[tauri::command]
pub fn refresh_active_tab(app: tauri::AppHandle, title: String) {
    let state = app.state::<WatcherState>();
    match resolve_and_read_tab(&state, &title) {
        Some(Ok((content, filename))) => {
            update_current_tab(&app, &content, &filename);
            dbg_log!("[refresh] Tab refreshed: {}", filename);
        }
        Some(Err(e)) => dbg_log!("[refresh] {}", e),
        None => {}
    }
}

/// Save content to a file path. Returns Ok(()) on success.
pub(crate) fn save_content_to_file(path: &std::path::Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("Save error: {}", e))
}

/// Resolve a tab title and save content to the corresponding file.
pub(crate) fn resolve_and_save_tab(
    state: &WatcherState,
    title: &str,
    content: &str,
) -> Result<std::path::PathBuf, String> {
    let path = crate::watcher::path_for_title(state, title)
        .ok_or_else(|| format!("No watched file for tab: {}", title))?;
    save_content_to_file(&path, content)?;
    Ok(path)
}

/// Tauri IPC command — save editor content to the file matching the active tab.
#[tauri::command]
pub fn save_file(app: tauri::AppHandle, title: String, content: String) {
    let state = app.state::<WatcherState>();
    match resolve_and_save_tab(&state, &title, &content) {
        Ok(path) => dbg_log!("[save] Saved: {}", path.display()),
        Err(e) => dbg_log!("[save] {}", e),
    }
}

/// Write text content to a file path. Extracted for testability.
pub(crate) fn write_text_export(path: &std::path::Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("Write error: {}", e))
}

/// Write binary content to a file path. Extracted for testability.
pub(crate) fn write_binary_export(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    std::fs::write(path, data).map_err(|e| format!("Write error: {}", e))
}

/// Tauri IPC command — export text content (MD / HTML) via native save dialog.
#[tauri::command]
pub fn export_text_file(
    app: tauri::AppHandle,
    default_name: String,
    content: String,
    filter_name: String,
    extensions: Vec<String>,
) {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    app.dialog()
        .file()
        .add_filter(&filter_name, &exts)
        .set_file_name(&default_name)
        .save_file(move |path| {
            let Some(fp) = path else { return };
            let path = match fp.into_path() {
                Ok(pb) => pb,
                Err(e) => {
                    dbg_log!("[export] Path error: {}", e);
                    return;
                }
            };
            match write_text_export(&path, &content) {
                Ok(_) => dbg_log!("[export] Saved: {}", path.display()),
                Err(e) => dbg_log!("[export] {}", e),
            }
        });
}

/// Tauri IPC command — export binary content (PDF) via native save dialog.
#[tauri::command]
pub fn export_binary_file(
    app: tauri::AppHandle,
    default_name: String,
    data: Vec<u8>,
    filter_name: String,
    extensions: Vec<String>,
) {
    let exts: Vec<&str> = extensions.iter().map(|s| s.as_str()).collect();
    app.dialog()
        .file()
        .add_filter(&filter_name, &exts)
        .set_file_name(&default_name)
        .save_file(move |path| {
            let Some(fp) = path else { return };
            let path = match fp.into_path() {
                Ok(pb) => pb,
                Err(e) => {
                    dbg_log!("[export] Path error: {}", e);
                    return;
                }
            };
            match write_binary_export(&path, &data) {
                Ok(_) => dbg_log!("[export] Saved: {}", path.display()),
                Err(e) => dbg_log!("[export] {}", e),
            }
        });
}

#[tauri::command]
pub fn is_default_md_app() -> bool {
    let result = crate::default_app::is_default_md_handler("com.markdowndesk.app");
    dbg_log!("[cmd] is_default_md_app: {}", result);
    result
}

#[tauri::command]
pub fn set_default_md_app() -> Result<(), String> {
    dbg_log!("[cmd] set_default_md_app");
    crate::default_app::set_as_default_md_handler("com.markdowndesk.app")
}

pub(crate) fn escape_js(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // --- escape_js tests ---

    #[test]
    fn escape_js_plain_text() {
        assert_eq!(escape_js("hello world"), "hello world");
    }

    #[test]
    fn escape_js_backticks() {
        assert_eq!(escape_js("say `hello`"), "say \\`hello\\`");
    }

    #[test]
    fn escape_js_backslashes() {
        assert_eq!(escape_js("path\\to\\file"), "path\\\\to\\\\file");
    }

    #[test]
    fn escape_js_template_literal() {
        assert_eq!(escape_js("value is ${x}"), "value is \\${x}");
    }

    #[test]
    fn escape_js_mixed() {
        assert_eq!(escape_js("a\\b `c` ${d}"), "a\\\\b \\`c\\` \\${d}");
    }

    #[test]
    fn escape_js_empty() {
        assert_eq!(escape_js(""), "");
    }

    #[test]
    fn escape_js_markdown_content() {
        let md = "# Title\n\n```rust\nfn main() {}\n```\n\nPrice: $100";
        let escaped = escape_js(md);
        assert!(escaped.contains("\\`\\`\\`rust"));
        assert!(escaped.contains("\\`\\`\\`\\n"));
        assert!(escaped.contains("$100"));
    }

    #[test]
    fn escape_js_nested_backslash_backtick() {
        assert_eq!(escape_js("\\`"), "\\\\\\`");
    }

    #[test]
    fn escape_js_dollar_without_brace() {
        assert_eq!(escape_js("$100"), "$100");
    }

    #[test]
    fn escape_js_multiline() {
        let input = "line1\nline2\nline3";
        assert_eq!(escape_js(input), "line1\\nline2\\nline3");
    }

    // --- filename_from_path tests ---

    #[test]
    fn filename_normal_path() {
        assert_eq!(filename_from_path(Path::new("/foo/bar/readme.md")), "readme.md");
    }

    #[test]
    fn filename_root_path() {
        assert_eq!(filename_from_path(Path::new("/")), "");
    }

    #[test]
    fn filename_with_spaces() {
        assert_eq!(filename_from_path(Path::new("/a/my file.md")), "my file.md");
    }

    #[test]
    fn filename_just_file() {
        assert_eq!(filename_from_path(Path::new("test.md")), "test.md");
    }

    // --- js_new_tab tests ---

    #[test]
    fn js_new_tab_contains_content_and_filename() {
        let js = js_new_tab("# Hello", "test.md");
        assert!(js.contains("# Hello"));
        assert!(js.contains("test.md"));
        assert!(js.contains("file-input"));
        assert!(js.contains("DataTransfer"));
    }

    #[test]
    fn js_new_tab_escapes_content() {
        let js = js_new_tab("has `backtick` and ${var}", "file.md");
        assert!(js.contains("\\`backtick\\`"));
        assert!(js.contains("\\${var}"));
    }

    #[test]
    fn js_new_tab_empty_content() {
        let js = js_new_tab("", "empty.md");
        assert!(js.contains("empty.md"));
        assert!(js.contains("file-input"));
    }

    #[test]
    fn js_new_tab_scrolls_to_top() {
        let js = js_new_tab("content", "f.md");
        assert!(js.contains("scrollTop = 0"));
        assert!(js.contains("window.scrollTo(0, 0)"));
    }

    // --- js_update_tab tests ---

    #[test]
    fn js_update_tab_contains_content() {
        let js = js_update_tab("# Updated", "test.md");
        assert!(js.contains("# Updated"));
        assert!(js.contains("markdown-editor"));
    }

    #[test]
    fn js_update_tab_escapes_content() {
        let js = js_update_tab("code `block` ${x}", "test.md");
        assert!(js.contains("\\`block\\`"));
        assert!(js.contains("\\${x}"));
    }

    #[test]
    fn js_update_tab_dispatches_input_event() {
        let js = js_update_tab("content", "test.md");
        assert!(js.contains("dispatchEvent"));
        assert!(js.contains("'input'"));
    }

    #[test]
    fn js_update_tab_scrolls_to_top() {
        let js = js_update_tab("content", "test.md");
        assert!(js.contains("scrollTop = 0"));
        assert!(js.contains("window.scrollTo(0, 0)"));
    }

    #[test]
    fn js_update_tab_empty() {
        let js = js_update_tab("", "empty.md");
        assert!(js.contains("empty.md"));
        assert!(js.contains("markdown-editor"));
    }

    #[test]
    fn js_update_tab_checks_active_tab_title() {
        let js = js_update_tab("content", "test.md");
        // Reads active tab title from DOM
        assert!(js.contains(".tab-item.active .tab-title"));
        assert!(js.contains("activeTitle"));
    }

    #[test]
    fn js_update_tab_skips_non_matching_tab() {
        let js = js_update_tab("content", "test.md");
        // Returns early if active tab doesn't match
        assert!(js.contains("activeTitle !== titleMatch"));
        assert!(js.contains("activeTitle !== filename"));
        assert!(js.contains("return"));
    }

    #[test]
    fn js_update_tab_matches_without_extension() {
        let js = js_update_tab("content", "test.md");
        assert!(js.contains("replace(/\\.md$/i, '')"));
    }

    #[test]
    fn js_update_tab_contains_filename() {
        let js = js_update_tab("content", "readme.md");
        assert!(js.contains("readme.md"));
    }

    #[test]
    fn js_update_tab_escapes_filename() {
        let js = js_update_tab("content", "file`name.md");
        assert!(js.contains("file\\`name.md"));
    }

    #[test]
    fn js_update_tab_filename_before_content() {
        // filename is set first (var filename), then content (editor.value)
        let js = js_update_tab("UNIQUE_CONTENT", "UNIQUE_FILE.md");
        let fname_pos = js.find("UNIQUE_FILE.md").unwrap();
        let content_pos = js.find("UNIQUE_CONTENT").unwrap();
        assert!(fname_pos < content_pos);
    }

    // --- js_add_watched_path tests ---

    #[test]
    fn js_add_watched_path_basic() {
        let js = js_add_watched_path("/Users/test/file.md");
        assert!(js.contains("localStorage"));
        assert!(js.contains("markdown-desk-watched-paths"));
        assert!(js.contains("/Users/test/file.md"));
    }

    #[test]
    fn js_add_watched_path_escapes_special() {
        let js = js_add_watched_path("/path/with `backtick`/file.md");
        assert!(js.contains("\\`backtick\\`"));
    }

    #[test]
    fn js_add_watched_path_spaces() {
        let js = js_add_watched_path("/Users/test/my documents/file.md");
        assert!(js.contains("my documents"));
    }

    #[test]
    fn js_add_watched_path_empty() {
        let js = js_add_watched_path("");
        assert!(js.contains("markdown-desk-watched-paths"));
        assert!(js.contains("localStorage"));
    }

    #[test]
    fn js_add_watched_path_unicode() {
        let js = js_add_watched_path("/Users/홍길동/문서/메모.md");
        assert!(js.contains("홍길동"));
        assert!(js.contains("메모.md"));
    }

    #[test]
    fn js_add_watched_path_template_literal() {
        let js = js_add_watched_path("/path/${dir}/file.md");
        // ${dir} should be escaped to \${dir}
        assert!(js.contains("\\${dir}"));
        // raw unescaped ${dir} should not appear (all occurrences are escaped)
        assert_eq!(
            js.matches("${dir}").count(),
            js.matches("\\${dir}").count()
        );
    }

    #[test]
    fn js_add_watched_path_correct_key() {
        let js = js_add_watched_path("/any/path.md");
        assert!(js.contains("markdown-desk-watched-paths"));
    }

    #[test]
    fn js_add_watched_path_deduplicates() {
        let js = js_add_watched_path("/any/path.md");
        assert!(js.contains("indexOf(p)<0"));
    }

    #[test]
    fn js_add_watched_path_is_iife() {
        let js = js_add_watched_path("/any/path.md");
        assert!(js.starts_with("(function()"));
        assert!(js.ends_with("()"));
    }

    // --- escape_js edge cases ---

    #[test]
    fn escape_js_consecutive_backticks() {
        assert_eq!(escape_js("````"), "\\`\\`\\`\\`");
    }

    #[test]
    fn escape_js_consecutive_backslashes() {
        assert_eq!(escape_js("\\\\"), "\\\\\\\\");
    }

    #[test]
    fn escape_js_template_literal_nested() {
        assert_eq!(escape_js("${${a}}"), "\\${\\${a}}");
    }

    #[test]
    fn escape_js_only_special_chars() {
        let input = "\\`${a}";
        let escaped = escape_js(input);
        assert_eq!(escaped, "\\\\\\`\\${a}");
    }

    #[test]
    fn escape_js_unicode() {
        assert_eq!(escape_js("한글 테스트 🎉"), "한글 테스트 🎉");
    }

    #[test]
    fn escape_js_tabs_preserved() {
        // Tabs are safe inside template literals
        assert!(escape_js("a\tb").contains("\t"));
    }

    #[test]
    fn escape_js_newlines_escaped() {
        assert_eq!(escape_js("a\nb"), "a\\nb");
    }

    #[test]
    fn escape_js_carriage_return_escaped() {
        assert_eq!(escape_js("a\rb"), "a\\rb");
    }

    #[test]
    fn escape_js_crlf_escaped() {
        assert_eq!(escape_js("a\r\nb"), "a\\r\\nb");
    }

    #[test]
    fn escape_js_large_content() {
        let large = "x".repeat(100_000);
        let escaped = escape_js(&large);
        assert_eq!(escaped.len(), 100_000);
    }

    // --- filename_from_path edge cases ---

    #[test]
    fn filename_hidden_file() {
        assert_eq!(filename_from_path(Path::new("/home/.hidden")), ".hidden");
    }

    #[test]
    fn filename_no_extension() {
        assert_eq!(filename_from_path(Path::new("/a/b/README")), "README");
    }

    #[test]
    fn filename_double_extension() {
        assert_eq!(filename_from_path(Path::new("/a/file.tar.gz")), "file.tar.gz");
    }

    #[test]
    fn filename_unicode_path() {
        assert_eq!(filename_from_path(Path::new("/문서/메모.md")), "메모.md");
    }

    #[test]
    fn filename_dot_path() {
        assert_eq!(filename_from_path(Path::new(".")), "");
    }

    // --- js_new_tab edge cases ---

    #[test]
    fn js_new_tab_is_iife() {
        let js = js_new_tab("x", "f.md");
        let trimmed = js.trim();
        assert!(trimmed.starts_with("(function()"));
        assert!(trimmed.ends_with("()"));
    }

    #[test]
    fn js_new_tab_large_content() {
        let large = "# heading\n".repeat(10_000);
        let js = js_new_tab(&large, "large.md");
        assert!(js.contains("large.md"));
        assert!(js.len() > large.len());
    }

    #[test]
    fn js_new_tab_special_filename() {
        let js = js_new_tab("content", "file`name${x}.md");
        assert!(js.contains("file\\`name\\${x}.md"));
    }

    #[test]
    fn js_new_tab_sets_file_type() {
        let js = js_new_tab("content", "f.md");
        assert!(js.contains("text/markdown"));
    }

    #[test]
    fn js_update_tab_skips_when_content_unchanged() {
        let js = js_update_tab("content", "test.md");
        assert!(js.contains("if (editor.value === newContent) return"));
    }

    // --- js_update_tab edge cases ---

    #[test]
    fn js_update_tab_is_iife() {
        let js = js_update_tab("x", "x.md");
        let trimmed = js.trim();
        assert!(trimmed.starts_with("(function()"));
        assert!(trimmed.ends_with("()"));
    }

    #[test]
    fn js_update_tab_large_content() {
        let large = "line\n".repeat(50_000);
        let js = js_update_tab(&large, "large.md");
        assert!(js.contains("large.md"));
        assert!(js.len() > large.len());
    }

    #[test]
    fn js_update_tab_unicode_content() {
        let js = js_update_tab("# 한글 제목\n\n본문입니다", "메모.md");
        assert!(js.contains("한글 제목"));
        assert!(js.contains("본문입니다"));
    }

    // --- js_new_tab and js_update_tab consistency ---

    #[test]
    fn js_new_tab_and_update_tab_both_scroll_to_top() {
        let new_js = js_new_tab("a", "a.md");
        let update_js = js_update_tab("a", "a.md");
        // Both should scroll to top
        assert!(new_js.contains("scrollTop = 0"));
        assert!(update_js.contains("scrollTop = 0"));
        assert!(new_js.contains("window.scrollTo(0, 0)"));
        assert!(update_js.contains("window.scrollTo(0, 0)"));
    }

    #[test]
    fn escape_js_safe_string_unchanged() {
        let safe = "hello world 123";
        assert_eq!(escape_js(safe), safe);
    }

    #[test]
    fn escape_js_double_escape_differs() {
        // String with special chars: double escaping should differ from single
        let input = "a\\b`c";
        let once = escape_js(input);
        let twice = escape_js(&once);
        assert_ne!(once, twice);
    }

    // --- write_text_export tests ---

    #[test]
    fn write_text_export_creates_file() {
        let dir = std::env::temp_dir().join("md_desk_test_text_export");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test_export.md");
        let content = "# Hello\n\nThis is a test.";
        assert!(write_text_export(&path, content).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_utf8_content() {
        let dir = std::env::temp_dir().join("md_desk_test_text_utf8");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("한글_export.html");
        let content = "<h1>안녕하세요</h1>";
        assert!(write_text_export(&path, content).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_empty_content() {
        let dir = std::env::temp_dir().join("md_desk_test_text_empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.md");
        assert!(write_text_export(&path, "").is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_overwrites_existing() {
        let dir = std::env::temp_dir().join("md_desk_test_text_overwrite");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("overwrite.md");
        std::fs::write(&path, "old content").unwrap();
        assert!(write_text_export(&path, "new content").is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_invalid_path_returns_error() {
        let path = Path::new("/nonexistent_dir_12345/file.md");
        assert!(write_text_export(path, "content").is_err());
    }

    // --- write_binary_export tests ---

    #[test]
    fn write_binary_export_creates_file() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_export");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test_export.pdf");
        let data: Vec<u8> = vec![0x25, 0x50, 0x44, 0x46]; // %PDF
        assert!(write_binary_export(&path, &data).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), data);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_binary_export_empty_data() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.pdf");
        assert!(write_binary_export(&path, &[]).is_ok());
        assert_eq!(std::fs::read(&path).unwrap().len(), 0);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_binary_export_large_data() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_large");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("large.pdf");
        let data: Vec<u8> = vec![0xAB; 1_000_000]; // 1MB
        assert!(write_binary_export(&path, &data).is_ok());
        assert_eq!(std::fs::read(&path).unwrap().len(), 1_000_000);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_binary_export_invalid_path_returns_error() {
        let path = Path::new("/nonexistent_dir_12345/file.pdf");
        assert!(write_binary_export(path, &[0x00]).is_err());
    }

    #[test]
    fn write_binary_export_overwrites_existing() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_overwrite");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("overwrite.pdf");
        std::fs::write(&path, &[0x01, 0x02]).unwrap();
        let new_data = vec![0x03, 0x04, 0x05];
        assert!(write_binary_export(&path, &new_data).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), new_data);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_large_content() {
        let dir = std::env::temp_dir().join("md_desk_test_text_large");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("large.md");
        let content = "# heading\n".repeat(10_000);
        assert!(write_text_export(&path, &content).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap().len(), content.len());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_multiline_html() {
        let dir = std::env::temp_dir().join("md_desk_test_text_html");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("export.html");
        let content = "<!DOCTYPE html>\n<html>\n<body>\n<h1>Test</h1>\n</body>\n</html>";
        assert!(write_text_export(&path, content).is_ok());
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("<!DOCTYPE html>"));
        assert!(saved.contains("<h1>Test</h1>"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_text_export_error_message_contains_detail() {
        let path = Path::new("/nonexistent_dir_12345/file.md");
        let err = write_text_export(path, "content").unwrap_err();
        assert!(err.starts_with("Write error:"));
    }

    #[test]
    fn write_binary_export_pdf_header_preserved() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_header");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("header.pdf");
        // Real PDF header: %PDF-1.4
        let data = b"%PDF-1.4\n".to_vec();
        assert!(write_binary_export(&path, &data).is_ok());
        let saved = std::fs::read(&path).unwrap();
        assert_eq!(&saved[..5], b"%PDF-");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn write_binary_export_error_message_contains_detail() {
        let path = Path::new("/nonexistent_dir_12345/file.pdf");
        let err = write_binary_export(path, &[0x00]).unwrap_err();
        assert!(err.starts_with("Write error:"));
    }

    #[test]
    fn write_binary_export_all_byte_values() {
        let dir = std::env::temp_dir().join("md_desk_test_bin_allbytes");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("allbytes.bin");
        let data: Vec<u8> = (0u8..=255).collect();
        assert!(write_binary_export(&path, &data).is_ok());
        assert_eq!(std::fs::read(&path).unwrap(), data);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    // --- read_and_prepare_file / read_and_prepare_files tests ---

    #[test]
    fn read_and_prepare_file_returns_content_and_filename() {
        let dir = std::env::temp_dir().join("md_desk_test_read_prepare");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("test.md");
        std::fs::write(&path, "# Hello").unwrap();

        let (content, filename) = read_and_prepare_file(&path).unwrap();
        assert_eq!(content, "# Hello");
        assert_eq!(filename, "test.md");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn read_and_prepare_file_nonexistent_returns_error() {
        let path = Path::new("/nonexistent_path_99999/missing.md");
        assert!(read_and_prepare_file(path).is_err());
    }

    #[test]
    fn read_and_prepare_files_multiple() {
        let dir = std::env::temp_dir().join("md_desk_test_read_multi");
        let _ = std::fs::create_dir_all(&dir);
        let p1 = dir.join("a.md");
        let p2 = dir.join("b.md");
        let p3 = dir.join("c.md");
        std::fs::write(&p1, "AAA").unwrap();
        std::fs::write(&p2, "BBB").unwrap();
        std::fs::write(&p3, "CCC").unwrap();

        let paths = vec![p1.clone(), p2.clone(), p3.clone()];
        let results = read_and_prepare_files(&paths);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].as_ref().unwrap().0, "AAA");
        assert_eq!(results[0].as_ref().unwrap().1, "a.md");
        assert_eq!(results[1].as_ref().unwrap().0, "BBB");
        assert_eq!(results[2].as_ref().unwrap().0, "CCC");

        let _ = std::fs::remove_file(&p1);
        let _ = std::fs::remove_file(&p2);
        let _ = std::fs::remove_file(&p3);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn read_and_prepare_files_skips_unreadable() {
        let dir = std::env::temp_dir().join("md_desk_test_read_skip");
        let _ = std::fs::create_dir_all(&dir);
        let good = dir.join("good.md");
        let bad = Path::new("/nonexistent_99999/bad.md").to_path_buf();
        std::fs::write(&good, "OK").unwrap();

        let paths = vec![good.clone(), bad];
        let results = read_and_prepare_files(&paths);
        assert_eq!(results.len(), 2);
        assert!(results[0].is_ok());
        assert!(results[1].is_err());

        let _ = std::fs::remove_file(&good);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn read_and_prepare_files_empty_list() {
        let paths: Vec<std::path::PathBuf> = vec![];
        let results = read_and_prepare_files(&paths);
        assert!(results.is_empty());
    }

    // --- validate_restore_path tests ---

    #[test]
    fn validate_restore_path_existing_file() {
        let dir = std::env::temp_dir().join("md_desk_test_restore");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("exists.md");
        std::fs::write(&path, "test").unwrap();

        let result = validate_restore_path(path.to_str().unwrap());
        assert!(result.is_some());
        assert_eq!(result.unwrap(), path);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn validate_restore_path_nonexistent() {
        let result = validate_restore_path("/nonexistent_path_99999/file.md");
        assert!(result.is_none());
    }

    #[test]
    fn validate_restore_path_empty_string() {
        let result = validate_restore_path("");
        // Empty string path does not exist
        assert!(result.is_none());
    }

    // --- save_content_to_file tests ---

    #[test]
    fn save_content_to_file_success() {
        let dir = std::env::temp_dir().join("md_desk_test_save");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("save_test.md");

        assert!(save_content_to_file(&path, "# Saved").is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Saved");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn save_content_to_file_overwrite() {
        let dir = std::env::temp_dir().join("md_desk_test_save_ow");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("overwrite.md");
        std::fs::write(&path, "old content").unwrap();

        assert!(save_content_to_file(&path, "new content").is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn save_content_to_file_invalid_path() {
        let path = Path::new("/nonexistent_dir_99999/file.md");
        let err = save_content_to_file(path, "test").unwrap_err();
        assert!(err.starts_with("Save error:"));
    }

    #[test]
    fn save_content_to_file_empty_content() {
        let dir = std::env::temp_dir().join("md_desk_test_save_empty");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("empty.md");

        assert!(save_content_to_file(&path, "").is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn save_content_to_file_unicode() {
        let dir = std::env::temp_dir().join("md_desk_test_save_uni");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("한글.md");

        assert!(save_content_to_file(&path, "# 한글 제목\n본문 내용").is_ok());
        assert!(std::fs::read_to_string(&path).unwrap().contains("한글 제목"));

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    // --- resolve_and_read_tab tests ---

    #[test]
    fn resolve_and_read_tab_found() {
        let dir = std::env::temp_dir().join("md_desk_test_resolve_read");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("resolve.md");
        std::fs::write(&path, "# Resolved").unwrap();

        let state = crate::watcher::WatcherState::new();
        state.files.lock().unwrap().insert("resolve.md".to_string(), path.clone());

        let result = resolve_and_read_tab(&state, "resolve.md");
        assert!(result.is_some());
        let (content, filename) = result.unwrap().unwrap();
        assert_eq!(content, "# Resolved");
        assert_eq!(filename, "resolve.md");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn resolve_and_read_tab_not_found() {
        let state = crate::watcher::WatcherState::new();
        assert!(resolve_and_read_tab(&state, "missing").is_none());
    }

    #[test]
    fn resolve_and_read_tab_title_without_ext() {
        let dir = std::env::temp_dir().join("md_desk_test_resolve_noext");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("notes.md");
        std::fs::write(&path, "content").unwrap();

        let state = crate::watcher::WatcherState::new();
        state.files.lock().unwrap().insert("notes.md".to_string(), path.clone());

        // "notes" should match "notes.md" via path_for_title fallback
        let result = resolve_and_read_tab(&state, "notes");
        assert!(result.is_some());
        assert_eq!(result.unwrap().unwrap().0, "content");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn resolve_and_read_tab_file_deleted() {
        let state = crate::watcher::WatcherState::new();
        // Path registered but file doesn't exist
        state.files.lock().unwrap().insert(
            "gone.md".to_string(),
            std::path::PathBuf::from("/nonexistent_99999/gone.md"),
        );

        let result = resolve_and_read_tab(&state, "gone.md");
        assert!(result.is_some());
        assert!(result.unwrap().is_err());
    }

    // --- resolve_and_save_tab tests ---

    #[test]
    fn resolve_and_save_tab_success() {
        let dir = std::env::temp_dir().join("md_desk_test_resolve_save");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("save.md");
        std::fs::write(&path, "old").unwrap();

        let state = crate::watcher::WatcherState::new();
        state.files.lock().unwrap().insert("save.md".to_string(), path.clone());

        let result = resolve_and_save_tab(&state, "save.md", "new content");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new content");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn resolve_and_save_tab_no_matching_file() {
        let state = crate::watcher::WatcherState::new();
        let err = resolve_and_save_tab(&state, "missing", "content").unwrap_err();
        assert!(err.contains("No watched file"));
    }

    #[test]
    fn resolve_and_save_tab_invalid_path() {
        let state = crate::watcher::WatcherState::new();
        state.files.lock().unwrap().insert(
            "bad.md".to_string(),
            std::path::PathBuf::from("/nonexistent_dir_99999/bad.md"),
        );

        let err = resolve_and_save_tab(&state, "bad.md", "content").unwrap_err();
        assert!(err.starts_with("Save error:"));
    }
}
