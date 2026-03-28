use std::io::Write;
use std::sync::Mutex;

static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

fn cache_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join("Library/Caches"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
}

pub fn init() {
    let log_dir = cache_dir().join("markdown-desk");
    let _ = std::fs::create_dir_all(&log_dir);
    let path = log_dir.join("debug.log");
    if let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        *LOG_FILE.lock().unwrap() = Some(f);
    } else {
        eprintln!("Warning: Failed to initialize log file at {}", path.display());
    }
}

/// Format a log line with timestamp prefix.
pub(crate) fn format_log_line(timestamp: &str, msg: &str) -> String {
    format!("[{}] {}\n", timestamp, msg)
}

pub fn log(msg: &str) {
    let line = format_log_line(&chrono_now(), msg);
    eprint!("{}", line);
    if let Ok(mut guard) = LOG_FILE.lock() {
        if let Some(ref mut f) = *guard {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

fn chrono_now() -> String {
    use std::time::SystemTime;
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    format!("{}.{:03}", secs, millis)
}

#[macro_export]
macro_rules! dbg_log {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrono_now_format() {
        let ts = chrono_now();
        let parts: Vec<&str> = ts.split('.').collect();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].parse::<u64>().is_ok());
        assert_eq!(parts[1].len(), 3);
    }

    #[test]
    fn log_does_not_panic_without_init() {
        log("test message");
    }

    #[test]
    fn format_log_line_basic() {
        assert_eq!(format_log_line("123.456", "hello"), "[123.456] hello\n");
    }

    #[test]
    fn format_log_line_empty_msg() {
        assert_eq!(format_log_line("0.000", ""), "[0.000] \n");
    }

    #[test]
    fn format_log_line_unicode() {
        let line = format_log_line("1.000", "한글 메시지");
        assert!(line.contains("한글 메시지"));
        assert!(line.starts_with('['));
        assert!(line.ends_with('\n'));
    }

    #[test]
    fn format_log_line_special_chars() {
        let line = format_log_line("1.000", "path: /a/b\ttab");
        assert_eq!(line, "[1.000] path: /a/b\ttab\n");
    }

    // --- cache_dir tests ---

    #[test]
    fn cache_dir_returns_library_caches() {
        // HOME is normally set on macOS
        if std::env::var("HOME").is_ok() {
            let dir = cache_dir();
            assert!(dir.to_string_lossy().ends_with("Library/Caches"));
        }
    }

    #[test]
    fn cache_dir_fallback_without_home() {
        // Temporarily unset HOME to test fallback
        let original = std::env::var("HOME").ok();
        std::env::remove_var("HOME");
        let dir = cache_dir();
        assert_eq!(dir, std::path::PathBuf::from("/tmp"));
        // Restore
        if let Some(home) = original {
            std::env::set_var("HOME", home);
        }
    }

    #[test]
    fn chrono_now_is_recent() {
        let ts = chrono_now();
        let secs: u64 = ts.split('.').next().unwrap().parse().unwrap();
        // Should be after 2024-01-01 (1704067200)
        assert!(secs > 1_704_067_200);
    }
}
