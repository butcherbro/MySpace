//! Minimal structured observability for the backend.
//!
//! Every Tauri command is wrapped with [`instrument`] (or [`instrument_infallible`]
//! for commands that cannot fail), which records a `command` span, its wall-clock
//! duration and its outcome (`ok` or an error *code* — never the error's message
//! text, which can embed user content such as filenames or note text; see
//! `domain::asset_service::gc_failure_summary` for the same precedent applied to
//! startup logging).
//!
//! Output goes to a daily-rolling log file under `<app data dir>/logs/myspace.log`
//! (JSON lines), plus stderr in debug builds. The verbosity is controlled by the
//! `MYSPACE_LOG` environment variable (default: `info`), using the same syntax as
//! `tracing_subscriber::EnvFilter` (e.g. `MYSPACE_LOG=debug` or
//! `MYSPACE_LOG=myspace_lib=debug,warn`).

use std::path::Path;
use std::time::{Duration, Instant};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::domain::errors::WorkspaceError;

/// A command is considered slow (and logged at `warn!` with `slow = true`) once
/// it runs past this threshold. This is the signal used to prioritize moving DB
/// work off the main thread.
const SLOW_COMMAND_THRESHOLD: Duration = Duration::from_millis(250);

/// Holds the non-blocking file appender's flush guard alive for the process
/// lifetime. Dropping it stops log writes, so it is stashed in Tauri's managed
/// state rather than left as a local in `setup`.
pub struct LogGuard(#[allow(dead_code)] pub Option<WorkerGuard>);

/// Installs the global `tracing` subscriber: a daily-rolling JSON file appender
/// under `<data_dir>/logs/myspace.log`, plus stderr in debug builds. Verbosity is
/// read from `MYSPACE_LOG` (default `info`).
///
/// Never panics: any failure (creating the log directory, installing the global
/// subscriber) is reported to stderr and yields `None`, so a broken logging setup
/// never blocks app startup.
pub fn init(data_dir: &Path) -> Option<WorkerGuard> {
    let log_dir = data_dir.join("logs");
    if let Err(err) = std::fs::create_dir_all(&log_dir) {
        eprintln!("telemetry: failed to create log dir: {err}");
        return None;
    }

    let file_appender = tracing_appender::rolling::daily(&log_dir, "myspace.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter =
        EnvFilter::try_from_env("MYSPACE_LOG").unwrap_or_else(|_| EnvFilter::new("info"));

    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(non_blocking)
        .with_ansi(false);

    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer);

    let install_result = if cfg!(debug_assertions) {
        let stderr_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(true);
        registry.with(stderr_layer).try_init()
    } else {
        registry.try_init()
    };

    if let Err(err) = install_result {
        eprintln!("telemetry: failed to install tracing subscriber: {err}");
        return None;
    }

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data_dir = %data_dir.display(),
        "myspace backend starting"
    );

    Some(guard)
}

/// A stable, content-free error code for a command outcome. Never the error's
/// `Display` text, which can embed user content (filenames, note text, paths).
pub trait ErrorCode {
    fn code(&self) -> &'static str;
}

impl ErrorCode for WorkspaceError {
    fn code(&self) -> &'static str {
        match self {
            WorkspaceError::NotFound(_) => "not_found",
            WorkspaceError::StaleRevision { .. } => "stale_revision",
            WorkspaceError::ConstraintViolation(_) => "constraint_violation",
            WorkspaceError::RootBoardProtected => "root_board_protected",
            WorkspaceError::Database(_) => "database",
        }
    }
}

/// Wraps a Tauri command body in a `command` span, timing it and logging its
/// outcome. On success: `info!` (or `warn!` with `slow = true` past the
/// threshold) with `outcome = "ok"`. On failure: `warn!` with `outcome = "error"`
/// and the error's stable `code()` — never its message text.
pub fn instrument<T, E: ErrorCode>(
    name: &'static str,
    f: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    let span = tracing::info_span!("command", name);
    let _enter = span.enter();

    let start = Instant::now();
    let result = f();
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    let slow = elapsed > SLOW_COMMAND_THRESHOLD;

    match &result {
        Ok(_) => {
            if slow {
                tracing::warn!(command = name, elapsed_ms, outcome = "ok", slow = true);
            } else {
                tracing::info!(command = name, elapsed_ms, outcome = "ok");
            }
        }
        Err(err) => {
            tracing::warn!(
                command = name,
                elapsed_ms,
                outcome = "error",
                error_code = err.code(),
                slow = slow,
            );
        }
    }

    result
}

/// Like [`instrument`], for commands that cannot fail (no `Result`).
pub fn instrument_infallible<T>(name: &'static str, f: impl FnOnce() -> T) -> T {
    let span = tracing::info_span!("command", name);
    let _enter = span.enter();

    let start = Instant::now();
    let result = f();
    let elapsed = start.elapsed();
    let elapsed_ms = elapsed.as_millis() as u64;
    let slow = elapsed > SLOW_COMMAND_THRESHOLD;

    if slow {
        tracing::warn!(command = name, elapsed_ms, outcome = "ok", slow = true);
    } else {
        tracing::info!(command = name, elapsed_ms, outcome = "ok");
    }

    result
}
