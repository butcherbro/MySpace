//! Card aggregate: card writes and the moves that change the board a card
//! belongs to. Per-kind projections (board load, single-card load) live in the
//! kind handlers (`domain::kinds`, P1.3); `load_cards`/`load_card` iterate the
//! registry.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::card_kind::{handler, registry, sql_in_list, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::kinds;
use crate::domain::models::{
    ApplyEmbedMetadataInput, CardDto, CardReceipt, CardsReceipt, ConvertNoteToEmbedInput,
    CreateImageCardInput, CreateLinkBatchInput, CreateLinkBatchResult, CreateNoteInput,
    EmbedCardDto, EmbedForMetadata, Frame, MoveCardToBoardInput, MoveCardsInput,
    MoveCardsToUnsortedInput, PlaceUnsortedCardInput, SetNoteColorInput, TextReceipt,
    UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput, UpdateNoteInput,
};
use crate::domain::plain_text::{document_to_plain_text, plain_text_to_document};

use super::super::db;
use super::immediate_tx;

/// Loads active cards of a board: every registered kind's
/// [`CardKindHandler::load_many`](crate::domain::card_kind::CardKindHandler::load_many),
/// in registry order. `unsorted` selects either the placed canvas cards
/// (false; portals carry child board/card counts) or the Unsorted panel cards
/// (true; portal counts are 0).
pub(super) fn load_cards(
    conn: &Connection,
    board_id: &str,
    unsorted: bool,
) -> Result<Vec<CardDto>, WorkspaceError> {
    let mut out = Vec::new();
    for handler in registry() {
        out.extend(handler.load_many(conn, board_id, unsorted)?);
    }
    Ok(out)
}

/// Loads a single active card by id, regardless of board. Used by the agent
/// surface to resolve `myspace://card/<id>` addresses (ADR-0005).
pub fn load_card(conn: &Connection, card_id: &str) -> Result<CardDto, WorkspaceError> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM cards WHERE id = ?1 AND deleted_at IS NULL",
            [card_id],
            |row| row.get(0),
        )
        .optional()?;

    let kind: CardKind = kind
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))?
        .parse()?;

    handler(kind)
        .load_one(conn, card_id)?
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))
}

/// Reads a card's stored revision back inside the write transaction, so a
/// receipt reports what SQLite holds rather than a revision computed in Rust.
fn stored_revision(tx: &Connection, id: &str) -> Result<i64, WorkspaceError> {
    Ok(
        tx.query_row("SELECT revision FROM cards WHERE id = ?1", [id], |r| {
            r.get(0)
        })?,
    )
}

/// Reads the stored revision and wraps it in a [`CardReceipt`].
fn card_receipt(tx: &Connection, id: &str) -> Result<CardReceipt, WorkspaceError> {
    Ok(CardReceipt {
        id: id.to_string(),
        revision: stored_revision(tx, id)?,
    })
}

/// Rejects a write over a stored document that is corrupt (P1.7) unless the
/// caller acknowledged it: the user must open the damaged card and repair it
/// first, so an autosave can never silently replace unrecoverable content.
/// `select` reads the stored document column for `?1`.
fn guard_corrupt_document(
    tx: &Connection,
    select: &str,
    id: &str,
    acknowledged: bool,
) -> Result<(), WorkspaceError> {
    if acknowledged {
        return Ok(());
    }
    let stored: Option<String> = tx.query_row(select, [id], |r| r.get(0)).optional()?;
    if stored.is_some_and(|text| kinds::is_corrupt_document(&text)) {
        return Err(WorkspaceError::ConstraintViolation(
            "document is corrupt; open it to repair first".into(),
        ));
    }
    Ok(())
}

/// A failed insert must leave no orphaned `cards` row: both inserts share one
/// transaction, so any failure rolls both back.
/// `plain_text` is derived from `document_json` here, never taken from the
/// caller.
pub fn create_note(
    conn: &mut Connection,
    input: &CreateNoteInput,
) -> Result<CardReceipt, WorkspaceError> {
    input.frame.validate()?;
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let plain_text = document_to_plain_text(&input.document_json);

    let tx = immediate_tx(conn)?;
    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)",
        params![
            input.id,
            input.board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            input.z_index,
            now,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO note_cards (card_id, document_json, plain_text)
         VALUES (?1, ?2, ?3)",
        params![input.id, document_json, plain_text],
    )?;
    let receipt = card_receipt(&tx, &input.id)?;
    tx.commit()?;

    Ok(receipt)
}

/// Updates a note's content, bumping its revision, guarded by an optimistic
/// `expected_revision`. A stale revision is rejected rather than silently
/// overwriting newer state (Section C invariant 11).
/// The stored `plain_text` is derived from `document_json` and returned in the
/// receipt.
pub fn update_note(
    conn: &mut Connection,
    input: &UpdateNoteInput,
) -> Result<TextReceipt, WorkspaceError> {
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let plain_text = document_to_plain_text(&input.document_json);

    let tx = immediate_tx(conn)?;
    guard_corrupt_document(
        &tx,
        "SELECT document_json FROM note_cards WHERE card_id = ?1",
        &input.id,
        input.acknowledge_corrupt,
    )?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    tx.execute(
        "UPDATE note_cards SET document_json = ?1, plain_text = ?2 WHERE card_id = ?3",
        params![document_json, plain_text, input.id],
    )?;

    let revision = stored_revision(&tx, &input.id)?;
    tx.commit()?;
    Ok(TextReceipt {
        id: input.id.clone(),
        revision,
        plain_text,
    })
}

/// Sets a note card's background color preset. This is orthogonal to text
/// content: it does NOT bump the card revision (so it never conflicts with a
/// concurrent text autosave) and it never touches `document_json`.
pub fn set_note_color(
    conn: &mut Connection,
    input: &SetNoteColorInput,
) -> Result<(), WorkspaceError> {
    let changed = conn.execute(
        "UPDATE note_cards SET color_token = ?1 WHERE card_id = ?2
         AND EXISTS (SELECT 1 FROM cards WHERE id = ?2 AND kind = 'note' AND deleted_at IS NULL)",
        params![input.color_token, input.id],
    )?;
    if changed == 0 {
        return Err(WorkspaceError::NotFound(input.id.clone()));
    }
    Ok(())
}

/// Updates an image card's caption, bumping its revision with an optimistic
/// `expected_revision` guard (mirrors `update_note`).
pub fn update_image_caption(
    conn: &mut Connection,
    input: &UpdateImageCaptionInput,
) -> Result<TextReceipt, WorkspaceError> {
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let caption_plain_text = document_to_plain_text(&input.caption_json);

    let tx = immediate_tx(conn)?;
    guard_corrupt_document(
        &tx,
        "SELECT caption_json FROM image_cards WHERE card_id = ?1",
        &input.id,
        input.acknowledge_corrupt,
    )?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3 AND kind = 'image'",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    tx.execute(
        "UPDATE image_cards SET caption_json = ?1, caption_plain_text = ?2 WHERE card_id = ?3",
        params![caption_json, caption_plain_text, input.id],
    )?;

    let revision = stored_revision(&tx, &input.id)?;
    tx.commit()?;
    Ok(TextReceipt {
        id: input.id.clone(),
        revision,
        plain_text: caption_plain_text,
    })
}

/// Updates a card's frame (position and size), bumping its revision with an
/// optimistic `expected_revision` guard. Works for both notes and portals.
pub fn update_card_frame(
    conn: &mut Connection,
    input: &UpdateCardFrameInput,
) -> Result<CardReceipt, WorkspaceError> {
    input.frame.validate()?;
    let now = db::migrations::now_millis();

    // One IMMEDIATE transaction so the stale-revision diagnosis reads the same
    // state the guarded UPDATE saw.
    let tx = immediate_tx(conn)?;
    let changed = tx.execute(
        "UPDATE cards
         SET x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
         WHERE id = ?6 AND revision = ?7",
        params![
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            now,
            input.id,
            input.expected_revision,
        ],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    let receipt = card_receipt(&tx, &input.id)?;
    tx.commit()?;
    Ok(receipt)
}

/// Moves multiple cards atomically (one gesture = one transaction). Every card
/// must match its expected revision, or the whole batch is rejected and rolled
/// back.
pub fn move_cards(
    conn: &mut Connection,
    input: &MoveCardsInput,
) -> Result<CardsReceipt, WorkspaceError> {
    for item in &input.cards {
        item.frame.validate()?;
    }
    let tx = immediate_tx(conn)?;
    let mut cards = Vec::with_capacity(input.cards.len());

    for item in &input.cards {
        let changed = tx.execute(
            "UPDATE cards
             SET x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?6 AND revision = ?7",
            params![
                item.frame.x,
                item.frame.y,
                item.frame.width,
                item.frame.height,
                db::migrations::now_millis(),
                item.id,
                item.expected_revision,
            ],
        )?;

        if changed == 0 {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM cards WHERE id = ?1",
                [item.id.clone()],
                |r| r.get(0),
            )?;
            if exists == 0 {
                return Err(WorkspaceError::NotFound(item.id.clone()));
            }
            let actual: i64 = tx.query_row(
                "SELECT revision FROM cards WHERE id = ?1",
                [item.id.clone()],
                |r| r.get(0),
            )?;
            return Err(WorkspaceError::StaleRevision {
                expected: item.expected_revision,
                actual,
            });
        }
        cards.push(card_receipt(&tx, &item.id)?);
    }

    tx.commit()?;
    Ok(CardsReceipt { cards })
}

/// Creates an image card referencing an already-imported asset, in one
/// transaction (cards row + image_cards row). A failed detail insert leaves no
/// orphaned `cards` row.
pub fn create_image_card(
    conn: &mut Connection,
    input: &CreateImageCardInput,
) -> Result<(), WorkspaceError> {
    input.frame.validate()?;
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let caption_plain_text = document_to_plain_text(&input.caption_json);

    let tx = immediate_tx(conn)?;

    // The referenced asset must exist.
    let asset_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM assets WHERE id = ?1",
        [input.asset_id.as_str()],
        |r| r.get(0),
    )?;
    if asset_exists == 0 {
        return Err(WorkspaceError::NotFound(input.asset_id.clone()));
    }

    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, 'image', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
        params![
            input.id,
            input.board_id,
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            input.z_index,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO image_cards (card_id, asset_id, caption_json, caption_plain_text)
         VALUES (?1, ?2, ?3, ?4)",
        params![input.id, input.asset_id, caption_json, caption_plain_text,],
    )?;
    tx.commit()?;

    Ok(())
}

/// Transactionally converts a Note into an Embed (Link) Card. The card identity,
/// frame, and z-index are preserved; `kind` changes from 'note' to 'embed', the
/// `note_cards` row is removed, and an `embed_cards` row is created. The source
/// URL is authoritative; metadata (title/description/preview) are network-free
/// fallback values at this stage and are enriched later.
///
/// Returns the authoritative `EmbedCardDto` so the frontend can atomically swap
/// the rendered card. Optimistic: rejects a stale `expected_revision`.
pub fn convert_note_to_embed(
    conn: &mut Connection,
    input: &ConvertNoteToEmbedInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let now = db::migrations::now_millis();
    let description_json = serde_json::to_string(&input.description_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let description_plain_text = document_to_plain_text(&input.description_json);

    let tx = immediate_tx(conn)?;

    // Guard: the card must be a live note at the expected revision.
    let kind_and_revision: Option<(String, i64)> = tx
        .query_row(
            "SELECT kind, revision FROM cards WHERE id = ?1 AND deleted_at IS NULL",
            [input.id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    match kind_and_revision {
        None => return Err(WorkspaceError::NotFound(input.id.clone())),
        Some((kind, _)) if kind != "note" => {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card {} is not a note (kind = {})",
                input.id, kind
            )));
        }
        Some((_, revision)) if revision != input.expected_revision => {
            return Err(WorkspaceError::StaleRevision {
                expected: input.expected_revision,
                actual: revision,
            });
        }
        Some(_) => {}
    }

    // Change kind + bump revision.
    tx.execute(
        "UPDATE cards SET kind = 'embed', revision = revision + 1, updated_at = ?1 WHERE id = ?2",
        params![now, input.id],
    )?;

    // Remove note storage.
    tx.execute(
        "DELETE FROM note_cards WHERE card_id = ?1",
        [input.id.as_str()],
    )?;

    // Create embed storage.
    tx.execute(
        "INSERT INTO embed_cards (
            card_id, source_url, display_url, site_name, title, provider,
            description_json, description_plain_text,
            asset_id, favicon_asset_id, preview_origin, metadata_status, metadata_error
         ) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, NULL, NULL, NULL, 'pending', NULL)",
        params![
            input.id,
            input.source_url,
            input.display_url,
            input.title,
            description_json,
            description_plain_text,
        ],
    )?;

    tx.commit()?;

    load_embed_card(conn, &input.id)
}

/// Loads a single embed card (with its optional asset joins) into a DTO.
pub fn load_embed_card(conn: &Connection, card_id: &str) -> Result<EmbedCardDto, WorkspaceError> {
    kinds::embed::load_embed(conn, card_id)?
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))
}

/// Updates an embed (Link) card's description body, bumping its revision,
/// guarded by an optimistic `expected_revision` (mirrors `update_note`).
pub fn update_embed_description(
    conn: &mut Connection,
    input: &UpdateEmbedDescriptionInput,
) -> Result<TextReceipt, WorkspaceError> {
    let now = db::migrations::now_millis();
    let description_json = serde_json::to_string(&input.description_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let description_plain_text = document_to_plain_text(&input.description_json);

    let tx = immediate_tx(conn)?;
    guard_corrupt_document(
        &tx,
        "SELECT description_json FROM embed_cards WHERE card_id = ?1",
        &input.id,
        input.acknowledge_corrupt,
    )?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3 AND kind = 'embed'",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    // Editing the description in the UI makes it a user-authored comment.
    tx.execute(
        "UPDATE embed_cards SET description_json = ?1, description_plain_text = ?2, description_origin = 'user' WHERE card_id = ?3",
        params![description_json, description_plain_text, input.id],
    )?;

    let revision = stored_revision(&tx, &input.id)?;
    tx.commit()?;
    Ok(TextReceipt {
        id: input.id.clone(),
        revision,
        plain_text: description_plain_text,
    })
}

/// Reads the minimal embed state needed before metadata fetching. Callers must
/// drop the DB lock before doing network work, then apply the result with the
/// same expected revision.
pub fn load_embed_for_metadata(
    conn: &Connection,
    id: &str,
    expected_revision: i64,
) -> Result<EmbedForMetadata, WorkspaceError> {
    let row = conn
        .query_row(
            "SELECT c.id, c.revision, e.source_url, e.display_url, COALESCE(e.title, ''), e.preview_origin, COALESCE(e.description_plain_text, ''), e.description_origin
             FROM cards c
             JOIN embed_cards e ON e.card_id = c.id
             WHERE c.id = ?1 AND c.kind = 'embed' AND c.deleted_at IS NULL",
            [id],
            |row| {
                Ok(EmbedForMetadata {
                    id: row.get(0)?,
                    revision: row.get(1)?,
                    source_url: row.get(2)?,
                    display_url: row.get(3)?,
                    title: row.get(4)?,
                    preview_origin: row.get(5)?,
                    description_plain_text: row.get(6)?,
                    description_origin: row.get(7)?,
                })
            },
        )
        .optional()?;

    let Some(embed) = row else {
        return Err(WorkspaceError::NotFound(id.to_string()));
    };

    if embed.revision != expected_revision {
        return Err(WorkspaceError::StaleRevision {
            expected: expected_revision,
            actual: embed.revision,
        });
    }

    Ok(embed)
}

/// Applies fetched metadata in one transaction. A custom preview is never
/// overwritten by a network refresh.
pub fn apply_embed_metadata(
    conn: &mut Connection,
    input: &ApplyEmbedMetadataInput,
) -> Result<EmbedCardDto, WorkspaceError> {
    let tx = immediate_tx(conn)?;
    apply_embed_metadata_in_tx(&tx, input)?;
    tx.commit()?;
    load_embed_card(conn, &input.id)
}

/// The body of [`apply_embed_metadata`] for callers that already hold the
/// write transaction (link enrichment records its asset rows, favicon-cache
/// rows and the card update atomically). Does not commit and does not reload.
pub fn apply_embed_metadata_in_tx(
    tx: &Connection,
    input: &ApplyEmbedMetadataInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let description_json = serde_json::to_string(&input.description_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    let description_plain_text = document_to_plain_text(&input.description_json);

    let current_preview_origin: Option<String> = tx
        .query_row(
            "SELECT e.preview_origin
             FROM cards c
             JOIN embed_cards e ON e.card_id = c.id
             WHERE c.id = ?1 AND c.kind = 'embed' AND c.deleted_at IS NULL",
            [input.id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.id.clone()))?;

    let changed = tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3 AND kind = 'embed' AND deleted_at IS NULL",
        params![now, input.id, input.expected_revision],
    )?;

    if changed == 0 {
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    if current_preview_origin.as_deref() == Some("custom") {
        tx.execute(
            "UPDATE embed_cards
             SET display_url = ?1, site_name = ?2, title = ?3, provider = ?4,
                 description_json = ?5, description_plain_text = ?6, description_origin = ?7,
                 favicon_asset_id = ?8, metadata_status = ?9, metadata_error = ?10
             WHERE card_id = ?11",
            params![
                input.display_url,
                input.site_name,
                input.title,
                input.provider,
                description_json,
                description_plain_text,
                input.description_origin,
                input.favicon_asset_id,
                input.metadata_status,
                input.metadata_error,
                input.id
            ],
        )?;
    } else {
        let next_preview_origin = input
            .preview_asset_id
            .as_ref()
            .map(|_| "fetched".to_string());
        tx.execute(
            "UPDATE embed_cards
             SET display_url = ?1, site_name = ?2, title = ?3, provider = ?4,
                 description_json = ?5, description_plain_text = ?6, description_origin = ?7,
                 asset_id = ?8, favicon_asset_id = ?9, preview_origin = ?10,
                 metadata_status = ?11, metadata_error = ?12
             WHERE card_id = ?13",
            params![
                input.display_url,
                input.site_name,
                input.title,
                input.provider,
                description_json,
                description_plain_text,
                input.description_origin,
                input.preview_asset_id,
                input.favicon_asset_id,
                next_preview_origin,
                input.metadata_status,
                input.metadata_error,
                input.id
            ],
        )?;
    }

    Ok(())
}

/// Moves a leaf card (note/image/embed) to a different board, resetting its
/// position to the target board's origin and bumping its revision with an
/// optimistic `expected_revision` guard. Used to drop a card onto a board portal.
pub fn move_card_to_board(
    conn: &mut Connection,
    input: &MoveCardToBoardInput,
) -> Result<CardReceipt, WorkspaceError> {
    let now = db::migrations::now_millis();

    let tx = immediate_tx(conn)?;

    // The target board must exist and not be trashed.
    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    let (dest_x, dest_y) = match &input.frame {
        Some(f) => (f.x, f.y),
        None => (40.0, 40.0),
    };

    let changed = tx.execute(
        &format!(
            "UPDATE cards
             SET board_id = ?1, x = ?2, y = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?5 AND revision = ?6 AND kind IN {}",
            sql_in_list(CardKind::LEAF)
        ),
        params![
            input.target_board_id,
            dest_x,
            dest_y,
            now,
            input.id,
            input.expected_revision
        ],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    let receipt = card_receipt(&tx, &input.id)?;
    tx.commit()?;
    Ok(receipt)
}

/// Atomically moves a group of cards into a Board's Unsorted panel. Every card
/// must match its expected revision or the whole batch is rejected and rolled
/// back (one batch = one undo unit). Cards keep their board_id (counts stay
/// correct) but are flagged unsorted so the canvas hides them and the rail shows
/// them as thumbnails.
pub fn move_cards_to_board_unsorted(
    conn: &mut Connection,
    input: &MoveCardsToUnsortedInput,
) -> Result<CardsReceipt, WorkspaceError> {
    let now = db::migrations::now_millis();

    let tx = immediate_tx(conn)?;

    // The target board must exist and not be trashed.
    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    // Validate every card revision up front so a stale one rolls back the batch.
    for item in &input.cards {
        let actual: i64 = tx.query_row(
            &format!(
                "SELECT revision FROM cards WHERE id = ?1 AND kind IN {}",
                sql_in_list(CardKind::LEAF)
            ),
            [item.id.as_str()],
            |r| r.get(0),
        )?;
        if actual != item.expected_revision {
            return Err(WorkspaceError::StaleRevision {
                expected: item.expected_revision,
                actual,
            });
        }
    }

    let mut cards = Vec::with_capacity(input.cards.len());
    for item in &input.cards {
        tx.execute(
            &format!(
                "UPDATE cards
                 SET board_id = ?1, unsorted = 1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND revision = ?4 AND kind IN {}",
                sql_in_list(CardKind::LEAF)
            ),
            params![input.target_board_id, now, item.id, item.expected_revision],
        )?;
        cards.push(card_receipt(&tx, &item.id)?);
    }

    tx.commit()?;
    Ok(CardsReceipt { cards })
}

/// Places one Unsorted card onto the board at an exact frame (unsorted = 0).
pub fn place_unsorted_card(
    conn: &mut Connection,
    input: &PlaceUnsortedCardInput,
) -> Result<CardReceipt, WorkspaceError> {
    input.frame.validate()?;
    let now = db::migrations::now_millis();

    // One IMMEDIATE transaction so the stale-revision diagnosis reads the same
    // state the guarded UPDATE saw.
    let tx = immediate_tx(conn)?;
    let changed = tx.execute(
        &format!(
            "UPDATE cards
             SET unsorted = 0, x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?6 AND revision = ?7 AND kind IN {}",
            sql_in_list(CardKind::LEAF)
        ),
        params![
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            now,
            input.id,
            input.expected_revision,
        ],
    )?;

    if changed == 0 {
        let exists: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    let receipt = card_receipt(&tx, &input.id)?;
    tx.commit()?;
    Ok(receipt)
}

/// Creates a batch of Link Cards in one durable operation. Idempotent under a
/// caller-supplied `idempotency_key`: a replayed key returns the original batch
/// id and card ids instead of creating duplicates. Cards are placed with a
/// deterministic downward cascade so they never overlap unseen.
pub fn create_link_batch(
    conn: &mut Connection,
    input: &CreateLinkBatchInput,
) -> Result<CreateLinkBatchResult, WorkspaceError> {
    let now = db::migrations::now_millis();

    // BEGIN IMMEDIATE before the replay check: two writers replaying the same
    // idempotency key must not both miss the receipt and both insert cards.
    let tx = immediate_tx(conn)?;

    // Idempotent replay: return the recorded result for a seen key.
    if let Some((batch_id, card_ids_json)) = tx
        .query_row(
            "SELECT batch_id, card_ids FROM mutation_receipts WHERE idempotency_key = ?1",
            [input.idempotency_key.as_str()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        let card_ids: Vec<String> = serde_json::from_str(&card_ids_json).unwrap_or_default();
        return Ok(CreateLinkBatchResult { batch_id, card_ids });
    }

    // The target board must exist and be active.
    let board_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if board_exists == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }

    let batch_id = uuid::Uuid::now_v7().to_string();
    let mut card_ids = Vec::with_capacity(input.links.len());
    let mut next_y = next_card_y(&tx, &input.board_id);

    for link in &input.links {
        let display_url = link.source_url.clone(); // enriched later if needed
                                                   // A user comment becomes the link's description body (authoritative).
        let description = link.description.trim();
        let description_doc = if description.is_empty() {
            serde_json::json!({"type": "doc", "content": []})
        } else {
            plain_text_to_document(description)
        };
        let description_json = serde_json::to_string(&description_doc)
            .map_err(|e| WorkspaceError::Database(e.to_string()))?;
        // Derived, never trusted: the same codec as every other text column.
        let description_plain_text = document_to_plain_text(&description_doc);

        let frame = Frame {
            x: 40.0,
            y: next_y,
            width: 320.0,
            height: 240.0,
        };
        frame.validate()?;
        tx.execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
             VALUES (?1, ?2, 'embed', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
            params![
                link.id,
                input.board_id,
                frame.x,
                frame.y,
                frame.width,
                frame.height,
                card_ids.len() as i64,
                now,
            ],
        )?;
        let description_origin = if description.is_empty() {
            None
        } else {
            Some("user")
        };
        tx.execute(
            "INSERT INTO embed_cards (card_id, source_url, display_url, title, description_json, description_plain_text, description_origin, metadata_status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
            params![link.id, link.source_url, display_url, link.title, description_json, description_plain_text, description_origin],
        )?;

        card_ids.push(link.id.clone());
        next_y += 264.0; // 240 height + 24 gap
    }

    let card_ids_json =
        serde_json::to_string(&card_ids).map_err(|e| WorkspaceError::Database(e.to_string()))?;
    tx.execute(
        "INSERT INTO mutation_receipts (idempotency_key, batch_id, card_ids, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![input.idempotency_key, batch_id, card_ids_json, now],
    )?;
    tx.commit()?;

    Ok(CreateLinkBatchResult { batch_id, card_ids })
}

/// Returns the card ids recorded for an agent batch id, if it exists.
pub fn load_batch_card_ids(
    conn: &Connection,
    agent_batch_id: &str,
) -> Result<Option<Vec<String>>, WorkspaceError> {
    let json: Option<String> = conn
        .query_row(
            "SELECT card_ids FROM mutation_receipts WHERE batch_id = ?1",
            [agent_batch_id],
            |r| r.get(0),
        )
        .optional()?;
    match json {
        Some(j) => Ok(Some(serde_json::from_str(&j).unwrap_or_default())),
        None => Ok(None),
    }
}

/// Returns the y coordinate for the next card on a board (cascade below the
/// lowest existing card).
fn next_card_y(conn: &Connection, board_id: &str) -> f64 {
    let max_bottom: f64 = conn
        .query_row(
            "SELECT COALESCE(MAX(y + height), 0.0) FROM cards WHERE board_id = ?1 AND deleted_at IS NULL",
            [board_id],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    if max_bottom <= 0.0 {
        return 40.0;
    }
    max_bottom + 24.0
}
