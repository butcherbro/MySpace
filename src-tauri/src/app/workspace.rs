//! The `Workspace` handle: one writer thread, a small read pool, one mutation
//! funnel.
//!
//! Before P1.1 every Tauri command was a synchronous `#[tauri::command]` that
//! locked a single `Mutex<Connection>` on the main thread, so a slow query or a
//! 5 s `qlmanage` froze the UI, and Tauri commands, the MCP adapter and startup
//! maintenance each called repository functions directly.
//!
//! Now:
//!
//! ```text
//! Tauri command (async fn)  ──►  Workspace (Clone, Send + Sync)
//! MCP adapter (blocking)    ──►      .read(|conn| …)   → read pool (N connections, WAL readers)
//!                                    .apply(Mutation)  → writer thread (1 connection, FIFO queue)
//!                                                        └─ sync::funnel::apply (one BEGIN IMMEDIATE)
//!                                                           ├─ Mutation::execute → domain / repository fn
//!                                                           ├─ journal rows (sync::tracking::flush)
//!                                                           └─ COMMIT → MutationOutcome
//! ```
//!
//! Invariants:
//! - Exactly one connection in this process ever writes. Writes are applied in
//!   the order they were queued. SQLite's own lock arbitration is only needed
//!   against *other* processes (the MCP server, a second app instance).
//! - The writer thread does no network I/O. Slow file work (copying a dropped
//!   file, Quick Look, a metadata fetch) happens before the mutation is queued;
//!   the mutation carries the staged result.
//! - `WorkspaceError::Database` for a busy database is retried a bounded number
//!   of times by the writer, never surfaced to the caller as "database is
//!   locked" on the first attempt (see [`BUSY_RETRIES`]).
//! - Telemetry records queue wait separately from execution (`queue_ms`,
//!   `exec_ms`), so a slow command can be attributed to contention or to the
//!   query itself.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tokio::sync::{oneshot, Notify};

use crate::db;
use crate::domain::errors::WorkspaceError;
use crate::domain::mutation::{Mutation, MutationOutcome};
use crate::telemetry::ErrorCode;

/// Number of pooled read connections. Two is enough for a desktop app: one
/// snapshot load plus one poll/search at a time. Increase when a third
/// long-running reader (FTS indexing, backup 2.0) lands.
pub const READ_POOL_SIZE: usize = 2;

/// How many times the writer re-runs a mutation that failed with a busy
/// database before returning the error. Each attempt already waits up to the
/// connection's `busy_timeout` (5 s), so this is insurance against a
/// pathological external writer, not the primary wait.
pub const BUSY_RETRIES: u32 = 3;

/// Filesystem layout of one workspace. Everything lives under `data_dir`.
#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    pub data_dir: PathBuf,
}

impl WorkspacePaths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("workspace.sqlite3")
    }

    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir.join("assets")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }
}

/// A job for the writer thread.
enum WriterJob {
    /// A domain mutation: executed with bounded busy-retry, instrumented.
    Mutate {
        mutation: Box<Mutation>,
        reply: oneshot::Sender<Result<MutationOutcome, WorkspaceError>>,
        enqueued: Instant,
    },
    /// A read that must observe the writer connection's own view (today only
    /// `PRAGMA data_version`, which reports commits by *other* connections and
    /// therefore must not run on a pooled reader, or every own write would look
    /// external). Goes away with P1.6's targeted invalidation.
    Inspect {
        job: Box<dyn FnOnce(&Connection) + Send>,
    },
}

struct ReadPool {
    idle: Mutex<Vec<Connection>>,
    available: Condvar,
}

impl ReadPool {
    fn acquire(&self) -> Result<Connection, WorkspaceError> {
        let mut idle = self
            .idle
            .lock()
            .map_err(|_| WorkspaceError::Database("read pool poisoned".into()))?;
        loop {
            if let Some(conn) = idle.pop() {
                return Ok(conn);
            }
            idle = self
                .available
                .wait(idle)
                .map_err(|_| WorkspaceError::Database("read pool poisoned".into()))?;
        }
    }

    fn release(&self, conn: Connection) {
        if let Ok(mut idle) = self.idle.lock() {
            idle.push(conn);
        }
        self.available.notify_one();
    }
}

/// Returns the pooled connection on drop, so an early `?` in a read closure
/// can never leak a connection.
struct PooledRead<'a> {
    pool: &'a ReadPool,
    conn: Option<Connection>,
}

impl Drop for PooledRead<'_> {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            self.pool.release(conn);
        }
    }
}

struct Inner {
    writer: Mutex<mpsc::Sender<WriterJob>>,
    readers: ReadPool,
    paths: WorkspacePaths,
    /// Signalled after every committed journaled mutation (S3: the LAN sync
    /// loop pulls and pokes its peers). Replays and local-only writes do not
    /// signal it.
    local_writes: Arc<Notify>,
}

/// Cheap-to-clone handle to the process's single workspace. Managed by Tauri as
/// state; constructed directly by the MCP binary and by tests.
#[derive(Clone)]
pub struct Workspace {
    inner: Arc<Inner>,
}

impl Workspace {
    /// Opens (creating and migrating if necessary) the workspace under
    /// `paths.data_dir`, runs first-run bootstrap, and starts the writer thread
    /// and read pool.
    pub fn open(paths: WorkspacePaths) -> Result<Self, WorkspaceError> {
        std::fs::create_dir_all(&paths.data_dir)
            .map_err(|e| WorkspaceError::Database(format!("cannot create data dir: {e}")))?;
        let writer = db::open_and_bootstrap(&paths.db_path())?;
        Self::from_connection(writer, paths)
    }

    /// Like [`Workspace::open`], but refuses to migrate: for a secondary process
    /// (the MCP server) that must never upgrade the schema out from under the
    /// main app.
    pub fn open_existing(paths: WorkspacePaths) -> Result<Self, WorkspaceError> {
        let writer = db::open_readonly_checked(&paths.db_path())?;
        Self::from_connection(writer, paths)
    }

    /// Builds the handle around an already-opened, migrated and bootstrapped
    /// writer connection. Read connections are opened against the same file
    /// with the schema already verified, so they never migrate.
    pub fn from_connection(
        writer_conn: Connection,
        paths: WorkspacePaths,
    ) -> Result<Self, WorkspaceError> {
        let db_path = paths.db_path();
        let mut idle = Vec::with_capacity(READ_POOL_SIZE);
        for _ in 0..READ_POOL_SIZE {
            idle.push(open_reader(&db_path)?);
        }

        let (tx, rx) = mpsc::channel::<WriterJob>();
        let writer_paths = paths.clone();
        let local_writes = Arc::new(Notify::new());
        let writer_notify = local_writes.clone();
        thread::Builder::new()
            .name("myspace-writer".into())
            .spawn(move || writer_loop(writer_conn, rx, writer_paths, writer_notify))
            .map_err(|e| WorkspaceError::Database(format!("cannot start writer thread: {e}")))?;

        Ok(Self {
            inner: Arc::new(Inner {
                writer: Mutex::new(tx),
                readers: ReadPool {
                    idle: Mutex::new(idle),
                    available: Condvar::new(),
                },
                paths,
                local_writes,
            }),
        })
    }

    pub fn paths(&self) -> &WorkspacePaths {
        &self.inner.paths
    }

    /// Notified after each committed journaled write of this process.
    pub fn local_writes(&self) -> Arc<Notify> {
        self.inner.local_writes.clone()
    }

    // ---- writes -----------------------------------------------------------

    /// Queues a mutation on the writer thread and awaits its outcome. This is
    /// the single write funnel: Tauri commands, the MCP adapter and startup
    /// maintenance all go through here.
    pub async fn apply(&self, mutation: Mutation) -> Result<MutationOutcome, WorkspaceError> {
        let rx = self.enqueue(mutation)?;
        rx.await
            .unwrap_or_else(|_| Err(WorkspaceError::Database("writer thread stopped".into())))
    }

    /// Blocking variant of [`Workspace::apply`] for synchronous callers (the
    /// MCP stdio loop, tests). Never call it from inside the async runtime.
    pub fn apply_blocking(&self, mutation: Mutation) -> Result<MutationOutcome, WorkspaceError> {
        let rx = self.enqueue(mutation)?;
        rx.blocking_recv()
            .unwrap_or_else(|_| Err(WorkspaceError::Database("writer thread stopped".into())))
    }

    /// Queues a mutation whose outcome nobody waits for (startup maintenance).
    /// A failure is logged by the writer with its error code.
    pub fn apply_detached(&self, mutation: Mutation) {
        if let Ok(rx) = self.enqueue(mutation) {
            drop(rx);
        }
    }

    fn enqueue(
        &self,
        mutation: Mutation,
    ) -> Result<oneshot::Receiver<Result<MutationOutcome, WorkspaceError>>, WorkspaceError> {
        let (reply, rx) = oneshot::channel();
        let job = WriterJob::Mutate {
            mutation: Box::new(mutation),
            reply,
            enqueued: Instant::now(),
        };
        self.send(job)?;
        Ok(rx)
    }

    fn send(&self, job: WriterJob) -> Result<(), WorkspaceError> {
        let sender = self
            .inner
            .writer
            .lock()
            .map_err(|_| WorkspaceError::Database("writer queue poisoned".into()))?;
        sender
            .send(job)
            .map_err(|_| WorkspaceError::Database("writer thread stopped".into()))
    }

    // ---- reads ------------------------------------------------------------

    /// Runs a read-only closure on a pooled connection, off the async runtime's
    /// worker threads. The closure must not write: a pooled reader never holds
    /// a write transaction, and a write here would race the writer thread.
    pub async fn read<T, F>(&self, f: F) -> Result<T, WorkspaceError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, WorkspaceError> + Send + 'static,
    {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.read_blocking(f))
            .await
            .map_err(|e| WorkspaceError::Database(format!("read task failed: {e}")))?
    }

    /// Blocking variant of [`Workspace::read`] for synchronous callers.
    pub fn read_blocking<T, F>(&self, f: F) -> Result<T, WorkspaceError>
    where
        F: FnOnce(&Connection) -> Result<T, WorkspaceError>,
    {
        let pool = &self.inner.readers;
        let guard = PooledRead {
            pool,
            conn: Some(pool.acquire()?),
        };
        let conn = guard
            .conn
            .as_ref()
            .expect("pooled connection present until drop");
        f(conn)
    }

    /// Runs a read-only closure on the *writer* connection, in queue order.
    /// Only for reads whose meaning depends on being the writer's own view
    /// (`PRAGMA data_version`). Everything else uses [`Workspace::read`].
    pub async fn inspect_writer<T, F>(&self, f: F) -> Result<T, WorkspaceError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, WorkspaceError> + Send + 'static,
    {
        let (reply, rx) = oneshot::channel();
        self.send(WriterJob::Inspect {
            job: Box::new(move |conn| {
                let _ = reply.send(f(conn));
            }),
        })?;
        rx.await
            .unwrap_or_else(|_| Err(WorkspaceError::Database("writer thread stopped".into())))
    }
}

fn open_reader(db_path: &Path) -> Result<Connection, WorkspaceError> {
    // `open_readonly_checked` applies the standard pragmas and verifies the
    // schema is exactly this build's; it never migrates. The name refers to the
    // schema policy, not to SQLite's read-only mode: readers stay ordinary
    // connections so tests can prove they are never used to write.
    Ok(db::open_readonly_checked(db_path)?)
}

fn writer_loop(
    mut conn: Connection,
    rx: mpsc::Receiver<WriterJob>,
    paths: WorkspacePaths,
    local_writes: Arc<Notify>,
) {
    while let Ok(job) = rx.recv() {
        match job {
            WriterJob::Inspect { job } => job(&conn),
            WriterJob::Mutate {
                mutation,
                reply,
                enqueued,
            } => {
                let outcome = run_mutation(&mut conn, &mutation, &paths, enqueued);
                if outcome.is_ok() && mutation.is_journaled() {
                    local_writes.notify_one();
                }
                if reply.send(outcome).is_err() {
                    // Detached job or the caller went away: nothing to deliver.
                }
            }
        }
    }
    // Channel closed: every handle dropped. The connection closes with us.
}

fn run_mutation(
    conn: &mut Connection,
    mutation: &Mutation,
    paths: &WorkspacePaths,
    enqueued: Instant,
) -> Result<MutationOutcome, WorkspaceError> {
    let name = mutation.op_name();
    let span = tracing::info_span!("mutation", op = name);
    let _enter = span.enter();

    let started = Instant::now();
    let queue_ms = started.duration_since(enqueued).as_millis() as u64;

    let mut attempt = 0u32;
    let result = loop {
        // The pre-destructive backup runs once, outside the transaction.
        if attempt == 0 {
            if let Err(err) = mutation.prepare(paths) {
                break Err(err);
            }
        }
        match crate::sync::funnel::apply(conn, mutation, paths) {
            Err(err) if err.is_busy() && attempt < BUSY_RETRIES => {
                attempt += 1;
                let backoff = busy_backoff(attempt);
                tracing::warn!(
                    op = name,
                    attempt,
                    backoff_ms = backoff.as_millis() as u64,
                    "mutation: database busy, retrying"
                );
                thread::sleep(backoff);
            }
            other => break other,
        }
    };

    let exec_ms = started.elapsed().as_millis() as u64;
    let slow = started.elapsed() > crate::telemetry::SLOW_COMMAND_THRESHOLD;
    match &result {
        Ok(_) if slow => {
            tracing::warn!(
                op = name,
                queue_ms,
                exec_ms,
                retries = attempt,
                outcome = "ok",
                slow = true
            )
        }
        Ok(_) => tracing::info!(
            op = name,
            queue_ms,
            exec_ms,
            retries = attempt,
            outcome = "ok"
        ),
        Err(err) => tracing::warn!(
            op = name,
            queue_ms,
            exec_ms,
            retries = attempt,
            outcome = "error",
            error_code = err.code(),
        ),
    }
    result
}

/// Exponential backoff with cheap jitter (no `rand` dependency): 25–50 ms,
/// 50–100 ms, 100–200 ms.
fn busy_backoff(attempt: u32) -> Duration {
    let base = 25u64 << (attempt.saturating_sub(1).min(4));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    Duration::from_millis(base + nanos % base)
}
