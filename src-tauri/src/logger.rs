use std::io::Write;
use std::sync::Mutex;

static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn init() {
    let path = "/tmp/markdown-desk-debug.log";
    if let Ok(f) = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
    {
        *LOG_FILE.lock().unwrap() = Some(f);
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
}
