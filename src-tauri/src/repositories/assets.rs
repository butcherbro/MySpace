//! Asset rows owned by other aggregates: the File Card's file and preview
//! assets, and the folder shortcut's bookmark locator. Split out of
//! `workspace_repository` without changing any SQL.

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CreateFileCardInput, CreateFilesystemAliasInput};

use super::super::db;
use super::immediate_tx;

pub fn create_filesystem_alias(
    conn: &mut Connection,
    input: &CreateFilesystemAliasInput,
) -> Result<(), WorkspaceError> {
    if input.target_kind != "folder" && input.target_kind != "file" {
        return Err(WorkspaceError::ConstraintViolation(
            "invalid alias target kind".into(),
        ));
    }
    let tx = immediate_tx(conn)?;
    // Idempotent replay: a compatible existing alias returns unchanged; a
    // conflicting reuse of the card id is rejected (no partial rows).
    let existing_kind: Option<String> = tx
        .query_row("SELECT kind FROM cards WHERE id = ?1", [&input.id], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(kind) = existing_kind {
        if kind == "filesystem_alias" {
            return Ok(());
        }
        return Err(WorkspaceError::ConstraintViolation(
            "card id already in use with a different kind".into(),
        ));
    }
    let now = db::migrations::now_millis();
    tx.execute("INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES (?1, ?2, 'filesystem_alias', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)", params![input.id, input.board_id, input.frame.x, input.frame.y, input.frame.width, input.frame.height, input.z_index, now])?;
    tx.execute("INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name) VALUES (?1, ?2, ?3, ?4, ?5)", params![input.id, input.target_kind, input.locator_blob, input.path_hint, input.display_name])?;
    tx.commit()?;
    Ok(())
}

/// Inserts the File Card rows (`cards` + `file_cards`) inside the caller's
/// transaction, so the staged asset rows and the card commit atomically. The
/// asset must already be copied and its preview read before this call. Idempotent
/// replay by card id returns Ok without inserting a second row.
pub fn insert_file_card_rows(
    tx: &Transaction<'_>,
    input: &CreateFileCardInput,
    asset_id: &str,
    preview_text: &str,
    preview_asset_id: Option<&str>,
) -> Result<(), WorkspaceError> {
    let existing_kind: Option<String> = tx
        .query_row("SELECT kind FROM cards WHERE id = ?1", [&input.id], |r| {
            r.get(0)
        })
        .optional()?;
    if let Some(kind) = existing_kind {
        if kind == "file" {
            return Ok(());
        }
        return Err(WorkspaceError::ConstraintViolation(
            "card id already in use with a different kind".into(),
        ));
    }
    let now = db::migrations::now_millis();
    tx.execute("INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)", params![input.id, input.board_id, input.frame.x, input.frame.y, input.frame.width, input.frame.height, input.z_index, now])?;
    tx.execute("INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text, source_path, preview_asset_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![input.id, asset_id, input.mime_type, preview_text, input.source_path, preview_asset_id])?;
    Ok(())
}

/// Internal-only authority lookup for Rust commands. No locator bytes appear in DTOs.
pub fn load_filesystem_alias_locator(
    conn: &Connection,
    card_id: &str,
) -> Result<(Vec<u8>, String, String), WorkspaceError> {
    conn.query_row(
        "SELECT a.locator_blob, a.path_hint, a.display_name FROM filesystem_aliases a JOIN cards c ON c.id = a.card_id WHERE a.card_id = ?1 AND c.deleted_at IS NULL",
        [card_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).map_err(WorkspaceError::from)
}

/// Returns the stored asset `file_path` for a File Card (for open-in-app).
pub fn load_file_card_asset(conn: &Connection, card_id: &str) -> Result<String, WorkspaceError> {
    conn.query_row(
        "SELECT a.file_path FROM file_cards f JOIN assets a ON a.id = f.asset_id JOIN cards c ON c.id = f.card_id WHERE f.card_id = ?1 AND c.deleted_at IS NULL",
        [card_id], |row| row.get(0),
    )
    .map_err(WorkspaceError::from)
}

/// Stale bookmark renewal is one durable transition: locator authority and
/// display diagnostics advance together, never from a path-hint fallback.
pub fn refresh_filesystem_alias_locator(
    conn: &mut Connection,
    card_id: &str,
    locator_blob: &[u8],
    path_hint: &str,
    display_name: &str,
) -> Result<(), WorkspaceError> {
    let updated = conn.execute(
        "UPDATE filesystem_aliases SET locator_blob = ?1, path_hint = ?2, display_name = ?3 WHERE card_id = ?4",
        params![locator_blob, path_hint, display_name, card_id],
    )?;
    if updated == 0 {
        return Err(WorkspaceError::NotFound(card_id.to_owned()));
    }
    Ok(())
}

/// Returns the original source path of a File Card, if recorded (for reveal-in-
/// Finder). Empty when the card predates migration 0014.
pub fn load_file_card_source_path(
    conn: &Connection,
    card_id: &str,
) -> Result<String, WorkspaceError> {
    conn.query_row(
        "SELECT f.source_path FROM file_cards f JOIN cards c ON c.id = f.card_id WHERE f.card_id = ?1 AND c.deleted_at IS NULL",
        [card_id],
        |row| row.get(0),
    )
    .map_err(WorkspaceError::from)
}
