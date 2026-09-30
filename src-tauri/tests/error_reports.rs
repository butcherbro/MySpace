//! Error reports: a report file lands under `<data dir>/error-reports/` with the
//! frontend's fields, the environment and a filtered tail of the newest log,
//! and old reports are rotated out.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use myspace_lib::commands::error_reports::{
    write_report, ErrorReportInput, LOG_TAIL_LINES, MAX_REPORTS,
};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "myspace-error-reports-{}-{}",
        tag,
        uuid::Uuid::now_v7()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn input() -> ErrorReportInput {
    ErrorReportInput {
        message: "database error: disk I/O".into(),
        code: Some("database".into()),
        board_id: Some("board-1".into()),
        source: Some("canvas".into()),
        frontend_version: "9.9.9".into(),
        user_agent: "Mozilla/5.0 Test".into(),
    }
}

/// 2026-09-26T13:35:11.591Z
fn fixed_now() -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(1_790_429_711_591)
}

fn write_log(data_dir: &Path, name: &str, content: &str) {
    let logs = data_dir.join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(logs.join(name), content).unwrap();
}

fn read_json(path: &str) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn report_files(data_dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(data_dir.join("error-reports"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn recent_log(json: &serde_json::Value) -> Vec<String> {
    json["recentLog"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn report_file_has_input_environment_and_timestamp() {
    let dir = temp_dir("fields");
    write_log(&dir, "myspace.log.2026-09-26", "{\"line\":1}\n");

    let saved = write_report(&dir, &input(), fixed_now()).unwrap();

    let path = PathBuf::from(&saved.path);
    assert_eq!(path.parent().unwrap(), dir.join("error-reports"));
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        name.starts_with("2026-09-26T13-35-11.591Z-") && name.ends_with(".json"),
        "{name}"
    );

    let json = read_json(&saved.path);
    assert_eq!(json["message"], "database error: disk I/O");
    assert_eq!(json["code"], "database");
    assert_eq!(json["boardId"], "board-1");
    assert_eq!(json["source"], "canvas");
    assert_eq!(json["frontendVersion"], "9.9.9");
    assert_eq!(json["userAgent"], "Mozilla/5.0 Test");
    assert_eq!(json["recordedAt"], "2026-09-26T13:35:11.591Z");
    assert_eq!(json["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(json["os"], std::env::consts::OS);
    assert_eq!(json["arch"], std::env::consts::ARCH);
    assert_eq!(recent_log(&json), vec!["{\"line\":1}".to_string()]);

    // The clipboard text carries the same facts in plain text.
    assert!(saved.text.contains("database error: disk I/O"));
    assert!(saved.text.contains("2026-09-26T13:35:11.591Z"));
    assert!(saved.text.contains(env!("CARGO_PKG_VERSION")));
    assert!(saved.text.contains("canvas"));
    assert!(saved.text.contains("{\"line\":1}"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_log_and_optional_fields_still_write_a_report() {
    let dir = temp_dir("minimal");
    let minimal = ErrorReportInput {
        code: None,
        board_id: None,
        source: None,
        ..input()
    };

    let saved = write_report(&dir, &minimal, fixed_now()).unwrap();

    let json = read_json(&saved.path);
    assert!(json["code"].is_null());
    assert!(json["boardId"].is_null());
    assert!(recent_log(&json).is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn recent_log_uses_newest_file_without_polling_noise_or_ansi() {
    let dir = temp_dir("noise");
    write_log(&dir, "myspace.log.2026-09-25", "{\"old\":true}\n");
    let lines = [
        r#"{"fields":{"command":"load_board_snapshot","outcome":"ok"}}"#,
        r#"{"fields":{"command":"get_board_change_seq","elapsed_ms":0,"outcome":"ok"}}"#,
        r#"{"fields":{"command":"list_trash","elapsed_ms":4,"outcome":"ok"}}"#,
        r#"{"fields":{"command":"get_sync_state","elapsed_ms":1,"outcome":"ok"}}"#,
        r#"{"fields":{"op":"sync.peers","queue_ms":0,"outcome":"ok"},"span":{"op":"sync.peers"}}"#,
        // Сбой опрашиваемой команды — не шум: именно он может быть причиной ошибки.
        r#"{"fields":{"command":"list_trash","outcome":"error","error_code":"database"}}"#,
        "\u{1b}[31mERROR\u{1b}[0m plain stderr line",
        r#"{"fields":{"message":"\u001b[1mbold\u001b[0m text"}}"#,
    ];
    write_log(&dir, "myspace.log.2026-09-26", &(lines.join("\n") + "\n"));

    let saved = write_report(&dir, &input(), fixed_now()).unwrap();

    assert_eq!(
        recent_log(&read_json(&saved.path)),
        vec![
            r#"{"fields":{"command":"load_board_snapshot","outcome":"ok"}}"#.to_string(),
            r#"{"fields":{"command":"list_trash","outcome":"error","error_code":"database"}}"#
                .to_string(),
            "ERROR plain stderr line".to_string(),
            r#"{"fields":{"message":"bold text"}}"#.to_string(),
        ]
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn recent_log_is_the_tail_of_a_large_file() {
    let dir = temp_dir("large");
    // ~2 MB: far past the read cap, so only the end of the file is read.
    let mut content = String::new();
    for i in 0..20_000 {
        content.push_str(&format!("{{\"n\":{i},\"pad\":\"{}\"}}\n", "x".repeat(80)));
    }
    write_log(&dir, "myspace.log.2026-09-26", &content);

    let saved = write_report(&dir, &input(), fixed_now()).unwrap();

    let log = recent_log(&read_json(&saved.path));
    assert_eq!(log.len(), LOG_TAIL_LINES);
    assert!(log.last().unwrap().starts_with("{\"n\":19999,"));
    assert!(log[0].starts_with(&format!("{{\"n\":{},", 20_000 - LOG_TAIL_LINES)));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn only_the_newest_reports_are_kept() {
    let dir = temp_dir("retention");
    let reports = dir.join("error-reports");
    std::fs::create_dir_all(&reports).unwrap();
    for i in 0..MAX_REPORTS + 5 {
        std::fs::write(
            reports.join(format!("2026-01-01T00-00-00.{i:03}Z-aaaaaa.json")),
            "{}",
        )
        .unwrap();
    }
    std::fs::write(reports.join("notes.txt"), "not a report").unwrap();

    let saved = write_report(&dir, &input(), fixed_now()).unwrap();

    let names = report_files(&dir);
    let json_count = names.iter().filter(|n| n.ends_with(".json")).count();
    assert_eq!(json_count, MAX_REPORTS);
    assert!(names.contains(&"notes.txt".to_string()));
    // The six oldest went; the new report stayed.
    assert!(!names.contains(&"2026-01-01T00-00-00.005Z-aaaaaa.json".to_string()));
    assert!(names.contains(&"2026-01-01T00-00-00.006Z-aaaaaa.json".to_string()));
    assert!(Path::new(&saved.path).exists());

    std::fs::remove_dir_all(&dir).ok();
}
