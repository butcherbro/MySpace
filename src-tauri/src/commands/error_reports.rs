//! Error reports: when the frontend shows an error, it records a report so the
//! developer can read it later without asking the user what happened.
//!
//! A report is a local JSON file under `<app data dir>/error-reports/` — not
//! database content, so it never enters a `Mutation` or sync. It carries the
//! frontend's fields, the app version, OS/arch and the recent tail of the
//! newest log file (polling noise dropped, ANSI colour codes stripped). At most
//! [`MAX_REPORTS`] files are kept. The command also returns a plain-text
//! rendering that the "Copy report" button puts on the clipboard.
//!
//! Takes the managed [`WorkspacePaths`], not the `Workspace`, so it also works
//! in recovery mode (P1.7).

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app::WorkspacePaths;
use crate::domain::errors::WorkspaceError;
use crate::telemetry::instrument_async;

/// How many log lines (after filtering) a report carries.
pub const LOG_TAIL_LINES: usize = 40;
/// How many report files are kept; older ones are deleted.
pub const MAX_REPORTS: usize = 200;
/// How much of the end of the log file is read to find those lines.
const LOG_TAIL_MAX_BYTES: u64 = 256 * 1024;
/// Commands the frontend polls every second or so; their routine successful
/// lines would push everything useful out of the tail.
const POLLING_NOISE: [&str; 4] = [
    "\"get_board_change_seq\"",
    "\"list_trash\"",
    "\"get_sync_state\"",
    "\"sync.peers\"",
];

/// What the frontend knows about the error it is showing.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReportInput {
    pub message: String,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub board_id: Option<String>,
    /// Where the error surfaced (`canvas`, `trash`, ...).
    #[serde(default)]
    pub source: Option<String>,
    pub frontend_version: String,
    pub user_agent: String,
}

/// Where the report was saved and its plain-text rendering for the clipboard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReportSaved {
    pub path: String,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorReport<'a> {
    #[serde(flatten)]
    input: &'a ErrorReportInput,
    recorded_at: String,
    app_version: &'static str,
    os: &'static str,
    arch: &'static str,
    recent_log: Vec<String>,
}

/// Records an error report. Best-effort: a failure is returned as an error,
/// which the frontend swallows.
#[tauri::command]
pub async fn record_error_report(
    paths: State<'_, WorkspacePaths>,
    report: ErrorReportInput,
) -> Result<ErrorReportSaved, WorkspaceError> {
    let data_dir = paths.data_dir.clone();
    instrument_async("record_error_report", async move {
        tokio::task::spawn_blocking(move || write_report(&data_dir, &report, SystemTime::now()))
            .await
            .map_err(|e| WorkspaceError::Database(format!("error report task failed: {e}")))?
            .map_err(WorkspaceError::Database)
    })
    .await
}

/// Writes `<data_dir>/error-reports/<UTC timestamp>-<random>.json` and prunes
/// the directory to [`MAX_REPORTS`] reports.
pub fn write_report(
    data_dir: &Path,
    input: &ErrorReportInput,
    now: SystemTime,
) -> Result<ErrorReportSaved, String> {
    let reports_dir = data_dir.join("error-reports");
    fs::create_dir_all(&reports_dir)
        .map_err(|e| format!("could not create the error reports folder: {e}"))?;

    let stamp = UtcStamp::from(now);
    let suffix = uuid::Uuid::now_v7().simple().to_string();
    // Хвост UUID v7 — случайные биты; начало — время, одинаковое у соседних отчётов.
    let file_name = format!("{}-{}.json", stamp.file_safe(), &suffix[suffix.len() - 6..]);
    let path = reports_dir.join(file_name);

    let report = ErrorReport {
        input,
        recorded_at: stamp.iso(),
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        recent_log: recent_log(&data_dir.join("logs")),
    };
    let json = serde_json::to_vec_pretty(&report)
        .map_err(|e| format!("could not serialize the error report: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("could not write the error report: {e}"))?;

    prune_reports(&reports_dir);

    Ok(ErrorReportSaved {
        text: render_text(&report, &path),
        path: path.display().to_string(),
    })
}

fn render_text(report: &ErrorReport<'_>, path: &Path) -> String {
    let input = report.input;
    let mut text = String::from("MySpace error report\n");
    text.push_str(&format!("Recorded: {}\n", report.recorded_at));
    text.push_str(&format!(
        "App version: {} (frontend {})\n",
        report.app_version, input.frontend_version
    ));
    text.push_str(&format!("OS: {} {}\n", report.os, report.arch));
    if let Some(source) = &input.source {
        text.push_str(&format!("Source: {source}\n"));
    }
    if let Some(board_id) = &input.board_id {
        text.push_str(&format!("Board: {board_id}\n"));
    }
    if let Some(code) = &input.code {
        text.push_str(&format!("Code: {code}\n"));
    }
    text.push_str(&format!("Message: {}\n", input.message));
    text.push_str(&format!("User agent: {}\n", input.user_agent));
    text.push_str(&format!("Saved to: {}\n", path.display()));
    text.push_str(&format!(
        "\nRecent log ({} lines):\n",
        report.recent_log.len()
    ));
    for line in &report.recent_log {
        text.push_str(line);
        text.push('\n');
    }
    text
}

/// The last [`LOG_TAIL_LINES`] meaningful lines of the newest log file, or
/// nothing when there is no readable log.
fn recent_log(log_dir: &Path) -> Vec<String> {
    let Some(file) = newest_log_file(log_dir) else {
        return Vec::new();
    };
    let Ok(tail) = read_tail(&file, LOG_TAIL_MAX_BYTES) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = tail
        .lines()
        .map(strip_ansi)
        .filter(|line| !line.trim().is_empty() && !is_polling_noise(line))
        .collect();
    let excess = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines.drain(..excess);
    lines
}

/// `tracing_appender::rolling::daily` names files `myspace.log.YYYY-MM-DD`, so
/// the newest is the greatest name.
fn newest_log_file(log_dir: &Path) -> Option<PathBuf> {
    fs::read_dir(log_dir)
        .ok()?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("myspace.log")
        })
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .max()
}

/// Reads at most `max_bytes` from the end of `path`, dropping the first,
/// partial line when the read starts mid-file.
fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(max_bytes).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    if start == 0 {
        return Ok(text.into_owned());
    }
    Ok(match text.find('\n') {
        Some(newline) => text[newline + 1..].to_string(),
        None => String::new(),
    })
}

/// A routine success of a polled command. Failures and slow calls of the same
/// commands are kept: they can be the very cause of the error.
fn is_polling_noise(line: &str) -> bool {
    POLLING_NOISE.iter().any(|marker| line.contains(marker))
        && !line.contains("\"outcome\":\"error\"")
        && !line.contains("\"slow\":true")
}

/// Removes ANSI CSI sequences (colour codes), both raw and in the JSON-escaped
/// form (`\u001b[...m`) the JSON log writes them in.
fn strip_ansi(line: &str) -> String {
    const ESCAPED: &str = "\\u001b";
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    loop {
        let raw = rest.find('\u{1b}').map(|at| (at, 1));
        let escaped = rest.find(ESCAPED).map(|at| (at, ESCAPED.len()));
        let next = match (raw, escaped) {
            (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
            (a, b) => a.or(b),
        };
        let Some((at, marker_len)) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at]);
        let after = &rest[at + marker_len..];
        rest = match after.strip_prefix('[') {
            // CSI заканчивается финальным байтом 0x40–0x7E; параметры (цифры, `;`) ниже.
            Some(params) => match params.find(|c: char| ('@'..='~').contains(&c)) {
                Some(end) => &params[end + 1..],
                None => "",
            },
            None => after,
        };
    }
}

/// Keeps the newest [`MAX_REPORTS`] `.json` reports. Names start with a UTC
/// timestamp, so name order is age order. Failures are ignored.
fn prune_reports(reports_dir: &Path) {
    let Ok(entries) = fs::read_dir(reports_dir) else {
        return;
    };
    let mut reports: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && path.is_file())
        .collect();
    if reports.len() <= MAX_REPORTS {
        return;
    }
    reports.sort();
    let excess = reports.len() - MAX_REPORTS;
    for old in &reports[..excess] {
        if let Err(error) = fs::remove_file(old) {
            tracing::warn!(%error, "error reports: could not remove an old report");
        }
    }
}

/// A UTC calendar timestamp with millisecond precision.
struct UtcStamp {
    year: i64,
    month: u32,
    day: u32,
    hour: u64,
    minute: u64,
    second: u64,
    millis: u32,
}

impl From<SystemTime> for UtcStamp {
    fn from(time: SystemTime) -> Self {
        let since_epoch = time.duration_since(UNIX_EPOCH).unwrap_or_default();
        let secs = since_epoch.as_secs();
        let (year, month, day) = civil_from_days((secs / 86_400) as i64);
        let of_day = secs % 86_400;
        Self {
            year,
            month,
            day,
            hour: of_day / 3_600,
            minute: of_day % 3_600 / 60,
            second: of_day % 60,
            millis: since_epoch.subsec_millis(),
        }
    }
}

impl UtcStamp {
    /// `2026-09-26T13:35:11.591Z`
    fn iso(&self) -> String {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            self.year, self.month, self.day, self.hour, self.minute, self.second, self.millis
        )
    }

    /// `2026-09-26T13-35-11.591Z`: no `:`, which Windows forbids in file names.
    fn file_safe(&self) -> String {
        self.iso().replace(':', "-")
    }
}

/// Days since 1970-01-01 to a proleptic Gregorian (year, month, day)
/// (Howard Hinnant's `civil_from_days`), so no date crate is needed.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}
