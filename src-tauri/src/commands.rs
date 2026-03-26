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

/// Open a file via native dialog, inject as new tab via file-input change event, start watching.
pub fn open_file_and_watch(app: &tauri::AppHandle) {
    let app_handle = app.clone();

    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file(move |file_path| {
            let Some(fp) = file_path else { return };
            let path = match fp.into_path() {
                Ok(pb) => pb,
                Err(e) => {
                    dbg_log!("[open] FilePath error: {}", e);
                    return;
                }
            };

            dbg_log!("[open] File: {}", path.display());

            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => {
                    dbg_log!("[open] Read error: {}", e);
                    return;
                }
            };

            let filename = filename_from_path(&path);
            dbg_log!("[open] {} bytes from {}", content.len(), filename);

            open_in_new_tab(&app_handle, &content, &filename);

            let state = app_handle.state::<WatcherState>();
            match crate::watcher::start_watching(&app_handle, &state, path) {
                Ok(_) => dbg_log!("[open] Watcher started"),
                Err(e) => dbg_log!("[open] Watcher error: {}", e),
            }
        });
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

/// Generate JS to update the current tab's editor content.
pub(crate) fn js_update_tab(content: &str) -> String {
    let js_content = escape_js(content);

    format!(
        r#"(function() {{
            var editor = document.getElementById('markdown-editor');
            if (editor) {{
                editor.value = `{}`;
                editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
                setTimeout(function() {{
                    editor.scrollTop = 0;
                    var preview = document.getElementById('preview');
                    if (preview) {{ preview.scrollTop = 0; }}
                    window.scrollTo(0, 0);
                }}, 100);
            }}
        }})()"#,
        js_content
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

/// Update content in the current tab (used by file watcher for live reload)
pub fn update_current_tab(app: &tauri::AppHandle, content: &str, filename: &str) {
    if let Some(ww) = app.get_webview_window("main") {
        let js = js_update_tab(content);
        match ww.eval(&js) {
            Ok(_) => dbg_log!("[update] OK: {}", filename),
            Err(e) => dbg_log!("[update] Failed: {}", e),
        }
    }
}

pub(crate) fn escape_js(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
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
        assert!(escaped.contains("\\`\\`\\`\n"));
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
        assert_eq!(escape_js(input), "line1\nline2\nline3");
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
        let js = js_update_tab("# Updated");
        assert!(js.contains("# Updated"));
        assert!(js.contains("markdown-editor"));
    }

    #[test]
    fn js_update_tab_escapes_content() {
        let js = js_update_tab("code `block` ${x}");
        assert!(js.contains("\\`block\\`"));
        assert!(js.contains("\\${x}"));
    }

    #[test]
    fn js_update_tab_dispatches_input_event() {
        let js = js_update_tab("content");
        assert!(js.contains("dispatchEvent"));
        assert!(js.contains("'input'"));
    }

    #[test]
    fn js_update_tab_scrolls_to_top() {
        let js = js_update_tab("content");
        assert!(js.contains("scrollTop = 0"));
        assert!(js.contains("window.scrollTo(0, 0)"));
    }

    #[test]
    fn js_update_tab_empty() {
        let js = js_update_tab("");
        assert!(js.contains("markdown-editor"));
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
    fn escape_js_tabs_and_carriage_return() {
        assert_eq!(escape_js("a\tb\r\n"), "a\tb\r\n");
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

    // --- js_update_tab edge cases ---

    #[test]
    fn js_update_tab_is_iife() {
        let js = js_update_tab("x");
        let trimmed = js.trim();
        assert!(trimmed.starts_with("(function()"));
        assert!(trimmed.ends_with("()"));
    }

    #[test]
    fn js_update_tab_large_content() {
        let large = "line\n".repeat(50_000);
        let js = js_update_tab(&large);
        assert!(js.contains("markdown-editor"));
        assert!(js.len() > large.len());
    }

    #[test]
    fn js_update_tab_unicode_content() {
        let js = js_update_tab("# 한글 제목\n\n본문입니다");
        assert!(js.contains("한글 제목"));
        assert!(js.contains("본문입니다"));
    }

    // --- js_new_tab and js_update_tab consistency ---

    #[test]
    fn js_new_tab_and_update_tab_both_scroll_to_top() {
        let new_js = js_new_tab("a", "a.md");
        let update_js = js_update_tab("a");
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
}
