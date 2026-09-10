//! Repository for reading board snapshots and creating notes.
//!
//! SQLite is authoritative (ADR-003). These functions are the only place that
//! maps database rows to domain DTOs and back.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    AddQuickBoardInput, ApplyEmbedMetadataInput, AssetDto, BoardPortalDto, BoardSnapshot,
    BoardSummary, Breadcrumb, CardDto, ConvertNoteToEmbedInput, CreateFileCardInput,
    CreateFilesystemAliasInput, CreateImageCardInput, CreateLinkBatchInput, CreateLinkBatchResult,
    CreateNoteInput, EmbedCardDto, EmbedForMetadata, FileCardDto, FilesystemAliasDto, Frame,
    ImageCardDto, MoveCardToBoardInput, MoveCardsInput, MoveCardsToUnsortedInput, NoteCardDto,
    PlaceUnsortedCardInput, PortalTarget, QuickBoardDto, ReorderQuickBoardsInput, SearchResultDto,
    SetNoteColorInput, UpdateCardFrameInput, UpdateEmbedDescriptionInput, UpdateImageCaptionInput,
    UpdateNoteInput, UpdateViewportInput, Viewport,
};

use super::super::db;

/// Loads the complete, self-contained projection of a board.
pub fn load_board_snapshot(
    conn: &Connection,
    board_id: &str,
) -> Result<BoardSnapshot, WorkspaceError> {
    let board = load_board_summary(conn, board_id)?;
    let breadcrumbs = load_breadcrumbs(conn, board_id)?;
    let viewport = load_viewport(conn, board_id)?;
    let cards = load_cards(conn, board_id, true, false)?;
    let unsorted_cards = load_cards(conn, board_id, false, true)?;

    Ok(BoardSnapshot {
        board,
        breadcrumbs,
        viewport,
        cards,
        unsorted_cards,
    })
}

/// Lists all active (non-trashed) boards.
pub fn list_boards(conn: &Connection) -> Result<Vec<BoardSummary>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.title, b.parent_board_id, b.revision, b.color_token, b.symbol,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM boards b
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.deleted_at IS NULL
         ORDER BY b.created_at, b.id",
    )?;
    let rows = stmt.query_map([], |row| {
        let cover_asset = if row.get::<_, Option<String>>(6)?.is_some() {
            Some(AssetDto {
                id: row.get(6)?,
                file_name: row.get(7)?,
                mime_type: row.get(8)?,
                width: row.get(9)?,
                height: row.get(10)?,
                size_bytes: row.get(11)?,
                file_path: row.get(12)?,
            })
        } else {
            None
        };
        Ok(BoardSummary {
            id: row.get(0)?,
            title: row.get(1)?,
            parent_board_id: row.get(2)?,
            revision: row.get(3)?,
            color_token: row.get(4)?,
            symbol: row.get(5)?,
            cover_asset,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn load_board_summary(conn: &Connection, board_id: &str) -> Result<BoardSummary, WorkspaceError> {
    conn.query_row(
        "SELECT b.id, b.title, b.parent_board_id, b.revision, b.color_token, b.symbol,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM boards b
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.id = ?1 AND b.deleted_at IS NULL",
        [board_id],
        |row| {
            let cover_asset = if row.get::<_, Option<String>>(6)?.is_some() {
                Some(AssetDto {
                    id: row.get(6)?,
                    file_name: row.get(7)?,
                    mime_type: row.get(8)?,
                    width: row.get(9)?,
                    height: row.get(10)?,
                    size_bytes: row.get(11)?,
                    file_path: row.get(12)?,
                })
            } else {
                None
            };
            Ok(BoardSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                parent_board_id: row.get(2)?,
                revision: row.get(3)?,
                color_token: row.get(4)?,
                symbol: row.get(5)?,
                cover_asset,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Collects the ancestor chain from Home down to `board_id`, inclusive.
fn load_breadcrumbs(conn: &Connection, board_id: &str) -> Result<Vec<Breadcrumb>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE ancestors(id, title, parent_board_id, depth) AS (
            SELECT id, title, parent_board_id, 0 FROM boards WHERE id = ?1
            UNION ALL
            SELECT b.id, b.title, b.parent_board_id, a.depth - 1
            FROM boards b
            JOIN ancestors a ON b.id = a.parent_board_id
        )
        SELECT id, title FROM ancestors ORDER BY depth ASC",
    )?;

    let rows = stmt.query_map([board_id], |row| {
        Ok(Breadcrumb {
            id: row.get(0)?,
            title: row.get(1)?,
        })
    })?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn load_viewport(conn: &Connection, board_id: &str) -> Result<Viewport, WorkspaceError> {
    conn.query_row(
        "SELECT viewport_x, viewport_y, zoom, revision FROM board_view_states WHERE board_id = ?1",
        [board_id],
        |row| {
            Ok(Viewport {
                x: row.get(0)?,
                y: row.get(1)?,
                zoom: row.get(2)?,
                revision: row.get(3)?,
            })
        },
    )
    .map_err(WorkspaceError::from)
}

/// Loads active cards of a board. When `include_subtree_counts` is true, portal
/// targets carry child board/card counts. `unsorted` selects either the placed
/// canvas cards (0) or the Unsorted panel cards (1).
fn load_cards(
    conn: &Connection,
    board_id: &str,
    include_subtree_counts: bool,
    unsorted: bool,
) -> Result<Vec<CardDto>, WorkspaceError> {
    let mut out = Vec::new();
    let unsorted_flag: i64 = if unsorted { 1 } else { 0 };

    // Notes
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    n.document_json, n.plain_text, n.color_token
             FROM cards c
             JOIN note_cards n ON n.card_id = c.id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map(params![board_id, unsorted_flag], |row| {
            let document_json: String = row.get(8)?;
            let document_json: serde_json::Value =
                serde_json::from_str(&document_json).unwrap_or(serde_json::Value::Null);
            Ok(CardDto::Note(NoteCardDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                document_json,
                plain_text: row.get(9)?,
                color_token: row.get(10)?,
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Board portals. Child counts are aggregated in one query per portal via
    // correlated subqueries, avoiding an N+1 pattern.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    p.target_board_id, b.revision, b.title, b.color_token, b.symbol,
                    COALESCE(child.child_board_count, 0),
                    COALESCE(cardchild.child_card_count, 0),
                    ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
             FROM cards c
             JOIN board_portal_cards p ON p.card_id = c.id
             JOIN boards b ON b.id = p.target_board_id
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             LEFT JOIN (
                 SELECT parent_board_id, COUNT(*) AS child_board_count
                 FROM boards WHERE deleted_at IS NULL GROUP BY parent_board_id
             ) child ON child.parent_board_id = p.target_board_id
             LEFT JOIN (
                 SELECT board_id, COUNT(*) AS child_card_count
                 FROM cards WHERE deleted_at IS NULL GROUP BY board_id
             ) cardchild ON cardchild.board_id = p.target_board_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map(params![board_id, unsorted_flag], |row| {
            let target_id: String = row.get(8)?;
            let (child_board_count, child_card_count) = if include_subtree_counts {
                (row.get::<_, i64>(13)?, row.get::<_, i64>(14)?)
            } else {
                (0, 0)
            };
            let cover_asset = if row.get::<_, Option<String>>(15)?.is_some() {
                Some(AssetDto {
                    id: row.get(15)?,
                    file_name: row.get(16)?,
                    mime_type: row.get(17)?,
                    width: row.get(18)?,
                    height: row.get(19)?,
                    size_bytes: row.get(20)?,
                    file_path: row.get(21)?,
                })
            } else {
                None
            };
            Ok(CardDto::BoardPortal(BoardPortalDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                target: PortalTarget {
                    id: target_id,
                    board_revision: row.get(9)?,
                    title: row.get(10)?,
                    color_token: row.get(11)?,
                    symbol: row.get(12)?,
                    child_board_count,
                    child_card_count,
                    cover_asset,
                },
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Image cards: a static image plus an editable caption.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    i.asset_id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path,
                    i.caption_json, i.caption_plain_text
             FROM cards c
             JOIN image_cards i ON i.card_id = c.id
             JOIN assets a ON a.id = i.asset_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map(params![board_id, unsorted_flag], |row| {
            let caption_json: String = row.get(15)?;
            let caption_json: serde_json::Value =
                serde_json::from_str(&caption_json).unwrap_or(serde_json::Value::Null);
            Ok(CardDto::Image(ImageCardDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                asset: AssetDto {
                    id: row.get(8)?,
                    file_name: row.get(9)?,
                    mime_type: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    size_bytes: row.get(13)?,
                    file_path: row.get(14)?,
                },
                caption_json,
                caption_plain_text: row.get(16)?,
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Embed (Link) cards: URL surface with optional preview/favicon and a
    // versioned rich-text body. Columns mirror `load_embed_card`.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    e.source_url, e.display_url, e.site_name, e.title, e.provider,
                    e.description_json, e.description_plain_text, e.description_origin,
                    e.asset_id, e.favicon_asset_id, e.preview_origin, e.metadata_status, e.metadata_error,
                    pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                    fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path
             FROM cards c
             JOIN embed_cards e ON e.card_id = c.id
             LEFT JOIN assets pa ON pa.id = e.asset_id
             LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
             ORDER BY c.z_index, c.id",
        )?;
        let rows = stmt.query_map(params![board_id, unsorted_flag], |row| {
            let description_json: String = row.get(13)?;
            let description_json: serde_json::Value =
                serde_json::from_str(&description_json).unwrap_or(serde_json::Value::Null);

            let preview_asset = if row.get::<_, Option<String>>(16)?.is_some() {
                Some(AssetDto {
                    id: row.get(16)?,
                    file_name: row.get(21)?,
                    mime_type: row.get(22)?,
                    width: row.get(23)?,
                    height: row.get(24)?,
                    size_bytes: row.get(25)?,
                    file_path: row.get(26)?,
                })
            } else {
                None
            };

            let favicon_asset = if row.get::<_, Option<String>>(17)?.is_some() {
                Some(AssetDto {
                    id: row.get(17)?,
                    file_name: row.get(27)?,
                    mime_type: row.get(28)?,
                    width: row.get(29)?,
                    height: row.get(30)?,
                    size_bytes: row.get(31)?,
                    file_path: row.get(32)?,
                })
            } else {
                None
            };

            Ok(CardDto::Embed(EmbedCardDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                source_url: row.get(8)?,
                display_url: row.get(9)?,
                site_name: row.get(10)?,
                title: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                provider: row.get(12)?,
                description_json,
                description_plain_text: row.get(14)?,
                description_origin: row.get(15)?,
                favicon_asset,
                preview_asset,
                preview_origin: row.get(18)?,
                metadata_status: row.get(19)?,
                metadata_error: row.get(20)?,
            }))
        })?;

        for r in rows {
            out.push(r?);
        }
    }

    // Alias identity is SQLite-only: this projection never resolves locator bytes.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision, a.target_kind, a.path_hint, a.display_name
             FROM cards c JOIN filesystem_aliases a ON a.card_id = c.id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2 ORDER BY c.z_index, c.id",
        )?;
        for row in stmt.query_map(params![board_id, unsorted_flag], |row| {
            Ok(CardDto::FilesystemAlias(FilesystemAliasDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                target_kind: row.get(8)?,
                path_hint: row.get(9)?,
                display_name: row.get(10)?,
            }))
        })? {
            out.push(row?);
        }
    }

    // File cards: copied text-like files with their bounded inline preview.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    a.id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path,
                    f.preview_text
             FROM cards c
             JOIN file_cards f ON f.card_id = c.id
             JOIN assets a ON a.id = f.asset_id
             WHERE c.board_id = ?1 AND c.deleted_at IS NULL AND c.unsorted = ?2
             ORDER BY c.z_index, c.id",
        )?;
        for row in stmt.query_map(params![board_id, unsorted_flag], |row| {
            Ok(CardDto::File(FileCardDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                asset: AssetDto {
                    id: row.get(8)?,
                    file_name: row.get(9)?,
                    mime_type: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    size_bytes: row.get(13)?,
                    file_path: row.get(14)?,
                },
                preview_text: row.get(15)?,
            }))
        })? {
            out.push(row?);
        }
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

    let kind = kind.ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))?;

    match kind.as_str() {
        "note" => {
            conn.query_row(
                "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                        n.document_json, n.plain_text, n.color_token
                 FROM cards c
                 JOIN note_cards n ON n.card_id = c.id
                 WHERE c.id = ?1 AND c.deleted_at IS NULL",
                [card_id],
                |row| {
                    let document_json: String = row.get(8)?;
                    let document_json: serde_json::Value =
                        serde_json::from_str(&document_json).unwrap_or(serde_json::Value::Null);
                    Ok(CardDto::Note(NoteCardDto {
                        id: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        z_index: row.get(6)?,
                        revision: row.get(7)?,
                        document_json,
                        plain_text: row.get(9)?,
                        color_token: row.get(10)?,
                    }))
                },
            )
            .map_err(WorkspaceError::from)
        }
        "board_portal" => {
            conn.query_row(
                "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                        p.target_board_id, b.revision, b.title, b.color_token, b.symbol,
                        COALESCE(child.child_board_count, 0),
                        COALESCE(cardchild.child_card_count, 0),
                        ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
                 FROM cards c
                 JOIN board_portal_cards p ON p.card_id = c.id
                 JOIN boards b ON b.id = p.target_board_id
                 LEFT JOIN assets ca ON ca.id = b.cover_asset_id
                 LEFT JOIN (
                     SELECT parent_board_id, COUNT(*) AS child_board_count
                     FROM boards WHERE deleted_at IS NULL GROUP BY parent_board_id
                 ) child ON child.parent_board_id = p.target_board_id
                 LEFT JOIN (
                     SELECT board_id, COUNT(*) AS child_card_count
                     FROM cards WHERE deleted_at IS NULL GROUP BY board_id
                 ) cardchild ON cardchild.board_id = p.target_board_id
                 WHERE c.id = ?1 AND c.deleted_at IS NULL",
                [card_id],
                |row| {
                    let cover_asset = if row.get::<_, Option<String>>(15)?.is_some() {
                        Some(AssetDto {
                            id: row.get(15)?,
                            file_name: row.get(16)?,
                            mime_type: row.get(17)?,
                            width: row.get(18)?,
                            height: row.get(19)?,
                            size_bytes: row.get(20)?,
                            file_path: row.get(21)?,
                        })
                    } else {
                        None
                    };
                    Ok(CardDto::BoardPortal(BoardPortalDto {
                        id: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        z_index: row.get(6)?,
                        revision: row.get(7)?,
                        target: PortalTarget {
                            id: row.get(8)?,
                            board_revision: row.get(9)?,
                            title: row.get(10)?,
                            color_token: row.get(11)?,
                            symbol: row.get(12)?,
                            child_board_count: row.get(13)?,
                            child_card_count: row.get(14)?,
                            cover_asset,
                        },
                    }))
                },
            )
            .map_err(WorkspaceError::from)
        }
        "image" => {
            conn.query_row(
                "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                        i.asset_id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path,
                        i.caption_json, i.caption_plain_text
                 FROM cards c
                 JOIN image_cards i ON i.card_id = c.id
                 JOIN assets a ON a.id = i.asset_id
                 WHERE c.id = ?1 AND c.deleted_at IS NULL",
                [card_id],
                |row| {
                    let caption_json: String = row.get(15)?;
                    let caption_json: serde_json::Value =
                        serde_json::from_str(&caption_json).unwrap_or(serde_json::Value::Null);
                    Ok(CardDto::Image(ImageCardDto {
                        id: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        z_index: row.get(6)?,
                        revision: row.get(7)?,
                        asset: AssetDto {
                            id: row.get(8)?,
                            file_name: row.get(9)?,
                            mime_type: row.get(10)?,
                            width: row.get(11)?,
                            height: row.get(12)?,
                            size_bytes: row.get(13)?,
                            file_path: row.get(14)?,
                        },
                        caption_json,
                        caption_plain_text: row.get(16)?,
                    }))
                },
            )
            .map_err(WorkspaceError::from)
        }
        "embed" => {
            conn.query_row(
                "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                        e.source_url, e.display_url, e.site_name, e.title, e.provider,
                        e.description_json, e.description_plain_text, e.description_origin,
                        e.asset_id, e.favicon_asset_id, e.preview_origin, e.metadata_status, e.metadata_error,
                        pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                        fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path
                 FROM cards c
                 JOIN embed_cards e ON e.card_id = c.id
                 LEFT JOIN assets pa ON pa.id = e.asset_id
                 LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
                 WHERE c.id = ?1 AND c.deleted_at IS NULL",
                [card_id],
                |row| {
                    let description_json: String = row.get(13)?;
                    let description_json: serde_json::Value =
                        serde_json::from_str(&description_json).unwrap_or(serde_json::Value::Null);

                    let preview_asset = if row.get::<_, Option<String>>(16)?.is_some() {
                        Some(AssetDto {
                            id: row.get(16)?,
                            file_name: row.get(21)?,
                            mime_type: row.get(22)?,
                            width: row.get(23)?,
                            height: row.get(24)?,
                            size_bytes: row.get(25)?,
                            file_path: row.get(26)?,
                        })
                    } else {
                        None
                    };

                    let favicon_asset = if row.get::<_, Option<String>>(17)?.is_some() {
                        Some(AssetDto {
                            id: row.get(17)?,
                            file_name: row.get(27)?,
                            mime_type: row.get(28)?,
                            width: row.get(29)?,
                            height: row.get(30)?,
                            size_bytes: row.get(31)?,
                            file_path: row.get(32)?,
                        })
                    } else {
                        None
                    };

                    Ok(CardDto::Embed(EmbedCardDto {
                        id: row.get(0)?,
                        board_id: row.get(1)?,
                        frame: Frame {
                            x: row.get(2)?,
                            y: row.get(3)?,
                            width: row.get(4)?,
                            height: row.get(5)?,
                        },
                        z_index: row.get(6)?,
                        revision: row.get(7)?,
                        source_url: row.get(8)?,
                        display_url: row.get(9)?,
                        site_name: row.get(10)?,
                        title: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                        provider: row.get(12)?,
                        description_json,
                        description_plain_text: row.get(14)?,
                        description_origin: row.get(15)?,
                        favicon_asset,
                        preview_asset,
                        preview_origin: row.get(18)?,
                        metadata_status: row.get(19)?,
                        metadata_error: row.get(20)?,
                    }))
                },
            )
            .map_err(WorkspaceError::from)
        }
        "filesystem_alias" => conn.query_row(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision, a.target_kind, a.path_hint, a.display_name FROM cards c JOIN filesystem_aliases a ON a.card_id = c.id WHERE c.id = ?1 AND c.deleted_at IS NULL",
            [card_id], |row| Ok(CardDto::FilesystemAlias(FilesystemAliasDto { id: row.get(0)?, board_id: row.get(1)?, frame: Frame { x: row.get(2)?, y: row.get(3)?, width: row.get(4)?, height: row.get(5)? }, z_index: row.get(6)?, revision: row.get(7)?, target_kind: row.get(8)?, path_hint: row.get(9)?, display_name: row.get(10)? }))
        ).map_err(WorkspaceError::from),
        "file" => conn.query_row(
            "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                    a.id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path,
                    f.preview_text
             FROM cards c
             JOIN file_cards f ON f.card_id = c.id
             JOIN assets a ON a.id = f.asset_id
             WHERE c.id = ?1 AND c.deleted_at IS NULL",
            [card_id], |row| Ok(CardDto::File(FileCardDto { id: row.get(0)?, board_id: row.get(1)?, frame: Frame { x: row.get(2)?, y: row.get(3)?, width: row.get(4)?, height: row.get(5)? }, z_index: row.get(6)?, revision: row.get(7)?, asset: AssetDto { id: row.get(8)?, file_name: row.get(9)?, mime_type: row.get(10)?, width: row.get(11)?, height: row.get(12)?, size_bytes: row.get(13)?, file_path: row.get(14)? }, preview_text: row.get(15)? }))
        ).map_err(WorkspaceError::from),
        other => Err(WorkspaceError::ConstraintViolation(format!(
            "unknown card kind: {other}"
        ))),
    }
}

pub fn create_filesystem_alias(
    conn: &mut Connection,
    input: &CreateFilesystemAliasInput,
) -> Result<(), WorkspaceError> {
    if input.target_kind != "folder" && input.target_kind != "file" {
        return Err(WorkspaceError::ConstraintViolation(
            "invalid alias target kind".into(),
        ));
    }
    // Idempotent replay: a compatible existing alias returns unchanged; a
    // conflicting reuse of the card id is rejected (no partial rows).
    let existing_kind: Option<String> = conn
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
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES (?1, ?2, 'filesystem_alias', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)", params![input.id, input.board_id, input.frame.x, input.frame.y, input.frame.width, input.frame.height, input.z_index, now])?;
    tx.execute("INSERT INTO filesystem_aliases (card_id, target_kind, locator_blob, path_hint, display_name) VALUES (?1, ?2, ?3, ?4, ?5)", params![input.id, input.target_kind, input.locator_blob, input.path_hint, input.display_name])?;
    tx.commit()?;
    Ok(())
}

/// Inserts a File Card: the asset must already be copied and its preview read
/// before this call; the cards + file_cards rows are committed atomically.
/// Idempotent replay by card id returns Ok without inserting a second row.
pub fn create_file_card(
    conn: &mut Connection,
    input: &CreateFileCardInput,
    asset_id: &str,
    preview_text: &str,
) -> Result<(), WorkspaceError> {
    let existing_kind: Option<String> = conn
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
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at) VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)", params![input.id, input.board_id, input.frame.x, input.frame.y, input.frame.width, input.frame.height, input.z_index, now])?;
    tx.execute("INSERT INTO file_cards (card_id, asset_id, mime_type, preview_text) VALUES (?1, ?2, ?3, ?4)", params![input.id, asset_id, input.mime_type, preview_text])?;
    tx.commit()?;
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
///
/// A failed insert must leave no orphaned `cards` row: both inserts share one
/// transaction, so any failure rolls both back.
pub fn create_note(conn: &mut Connection, input: &CreateNoteInput) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;
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
        params![input.id, document_json, input.plain_text],
    )?;
    tx.commit()?;

    Ok(())
}

/// Updates a note's content, bumping its revision, guarded by an optimistic
/// `expected_revision`. A stale revision is rejected rather than silently
/// overwriting newer state (Section C invariant 11).
pub fn update_note(conn: &mut Connection, input: &UpdateNoteInput) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let document_json = serde_json::to_string(&input.document_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

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
        params![document_json, input.plain_text, input.id],
    )?;

    tx.commit()?;
    Ok(())
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
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

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
        params![caption_json, input.caption_plain_text, input.id],
    )?;

    tx.commit()?;
    Ok(())
}

/// Updates a card's frame (position and size), bumping its revision with an
/// optimistic `expected_revision` guard. Works for both notes and portals.
pub fn update_card_frame(
    conn: &mut Connection,
    input: &UpdateCardFrameInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let changed = conn.execute(
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
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = conn.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    Ok(())
}

/// Persists a board's viewport, bumping its revision with an optimistic guard.
pub fn update_viewport(
    conn: &mut Connection,
    input: &UpdateViewportInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let changed = conn.execute(
        "UPDATE board_view_states
         SET viewport_x = ?1, viewport_y = ?2, zoom = ?3, revision = revision + 1, updated_at = ?4
         WHERE board_id = ?5 AND revision = ?6",
        params![
            input.x,
            input.y,
            input.zoom,
            now,
            input.board_id,
            input.expected_revision,
        ],
    )?;

    if changed == 0 {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.board_id.clone()));
        }
        let actual: i64 = conn.query_row(
            "SELECT revision FROM board_view_states WHERE board_id = ?1",
            [input.board_id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    Ok(())
}

/// Moves multiple cards atomically (one gesture = one transaction). Every card
/// must match its expected revision, or the whole batch is rejected and rolled
/// back.
pub fn move_cards(conn: &mut Connection, input: &MoveCardsInput) -> Result<(), WorkspaceError> {
    let tx = conn.transaction()?;

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
    }

    tx.commit()?;
    Ok(())
}

/// Creates an image card referencing an already-imported asset, in one
/// transaction (cards row + image_cards row). A failed detail insert leaves no
/// orphaned `cards` row.
pub fn create_image_card(
    conn: &mut Connection,
    input: &CreateImageCardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let caption_json = serde_json::to_string(&input.caption_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    // The referenced asset must exist.
    let asset_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM assets WHERE id = ?1",
        [input.asset_id.as_str()],
        |r| r.get(0),
    )?;
    if asset_exists == 0 {
        return Err(WorkspaceError::NotFound(input.asset_id.clone()));
    }

    let tx = conn.transaction()?;
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
        params![
            input.id,
            input.asset_id,
            caption_json,
            input.caption_plain_text,
        ],
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

    let tx = conn.transaction()?;

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
            input.description_plain_text,
        ],
    )?;

    tx.commit()?;

    load_embed_card(conn, &input.id)
}

/// Loads a single embed card (with its optional asset joins) into a DTO.
fn load_embed_card(conn: &Connection, card_id: &str) -> Result<EmbedCardDto, WorkspaceError> {
    let row = conn.query_row(
        "SELECT c.id, c.board_id, c.x, c.y, c.width, c.height, c.z_index, c.revision,
                e.source_url, e.display_url, e.site_name, e.title, e.provider,
                e.description_json, e.description_plain_text, e.description_origin,
                e.asset_id, e.favicon_asset_id, e.preview_origin, e.metadata_status, e.metadata_error,
                pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path
         FROM cards c
         JOIN embed_cards e ON e.card_id = c.id
         LEFT JOIN assets pa ON pa.id = e.asset_id
         LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
         WHERE c.id = ?1 AND c.deleted_at IS NULL",
        [card_id],
        |row| {
            let description_json: String = row.get(13)?;
            let description_json: serde_json::Value =
                serde_json::from_str(&description_json).unwrap_or(serde_json::Value::Null);

            let preview_asset = if row.get::<_, Option<String>>(16)?.is_some() {
                Some(AssetDto {
                    id: row.get(16)?,
                    file_name: row.get(21)?,
                    mime_type: row.get(22)?,
                    width: row.get(23)?,
                    height: row.get(24)?,
                    size_bytes: row.get(25)?,
                    file_path: row.get(26)?,
                })
            } else {
                None
            };

            let favicon_asset = if row.get::<_, Option<String>>(17)?.is_some() {
                Some(AssetDto {
                    id: row.get(17)?,
                    file_name: row.get(27)?,
                    mime_type: row.get(28)?,
                    width: row.get(29)?,
                    height: row.get(30)?,
                    size_bytes: row.get(31)?,
                    file_path: row.get(32)?,
                })
            } else {
                None
            };

            Ok(EmbedCardDto {
                id: row.get(0)?,
                board_id: row.get(1)?,
                frame: Frame {
                    x: row.get(2)?,
                    y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
                z_index: row.get(6)?,
                revision: row.get(7)?,
                source_url: row.get(8)?,
                display_url: row.get(9)?,
                site_name: row.get(10)?,
                title: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                provider: row.get(12)?,
                description_json,
                description_plain_text: row.get(14)?,
                description_origin: row.get(15)?,
                favicon_asset,
                preview_asset,
                preview_origin: row.get(18)?,
                metadata_status: row.get(19)?,
                metadata_error: row.get(20)?,
            })
        },
    );

    Ok(row?)
}

/// Updates an embed (Link) card's description body, bumping its revision,
/// guarded by an optimistic `expected_revision` (mirrors `update_note`).
pub fn update_embed_description(
    conn: &mut Connection,
    input: &UpdateEmbedDescriptionInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let description_json = serde_json::to_string(&input.description_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

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
        params![description_json, input.description_plain_text, input.id],
    )?;

    tx.commit()?;
    Ok(())
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
    let now = db::migrations::now_millis();
    let description_json = serde_json::to_string(&input.description_json)
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;

    let tx = conn.transaction()?;

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
                input.description_plain_text,
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
                input.description_plain_text,
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

    tx.commit()?;
    load_embed_card(conn, &input.id)
}

/// Moves a leaf card (note/image/embed) to a different board, resetting its
/// position to the target board's origin and bumping its revision with an
/// optimistic `expected_revision` guard. Used to drop a card onto a board portal.
pub fn move_card_to_board(
    conn: &mut Connection,
    input: &MoveCardToBoardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // The target board must exist and not be trashed.
    let target_exists: i64 = conn.query_row(
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

    let tx = conn.transaction()?;

    let changed = tx.execute(
        "UPDATE cards
         SET board_id = ?1, x = ?2, y = ?3, revision = revision + 1, updated_at = ?4
         WHERE id = ?5 AND revision = ?6 AND kind IN ('note', 'image', 'embed', 'filesystem_alias')",
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

    tx.commit()?;
    Ok(())
}

/// Atomically moves a group of cards into a Board's Unsorted panel. Every card
/// must match its expected revision or the whole batch is rejected and rolled
/// back (one batch = one undo unit). Cards keep their board_id (counts stay
/// correct) but are flagged unsorted so the canvas hides them and the rail shows
/// them as thumbnails.
pub fn move_cards_to_board_unsorted(
    conn: &mut Connection,
    input: &MoveCardsToUnsortedInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    // The target board must exist and not be trashed.
    let target_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.target_board_id.as_str()],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        return Err(WorkspaceError::NotFound(input.target_board_id.clone()));
    }

    let tx = conn.transaction()?;

    // Validate every card revision up front so a stale one rolls back the batch.
    for item in &input.cards {
        let actual: i64 = tx.query_row(
            "SELECT revision FROM cards WHERE id = ?1 AND kind IN ('note','image','embed','filesystem_alias')",
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

    for item in &input.cards {
        tx.execute(
            "UPDATE cards
             SET board_id = ?1, unsorted = 1, revision = revision + 1, updated_at = ?2
             WHERE id = ?3 AND revision = ?4 AND kind IN ('note','image','embed','filesystem_alias')",
            params![input.target_board_id, now, item.id, item.expected_revision],
        )?;
    }

    tx.commit()?;
    Ok(())
}

/// Places one Unsorted card onto the board at an exact frame (unsorted = 0).
pub fn place_unsorted_card(
    conn: &mut Connection,
    input: &PlaceUnsortedCardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let changed = conn.execute(
        "UPDATE cards
         SET unsorted = 0, x = ?1, y = ?2, width = ?3, height = ?4, revision = revision + 1, updated_at = ?5
         WHERE id = ?6 AND revision = ?7 AND kind IN ('note','image','embed','filesystem_alias')",
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
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(WorkspaceError::NotFound(input.id.clone()));
        }
        let actual: i64 = conn.query_row(
            "SELECT revision FROM cards WHERE id = ?1",
            [input.id.clone()],
            |r| r.get(0),
        )?;
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual,
        });
    }

    Ok(())
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

    // Idempotent replay: return the recorded result for a seen key.
    if let Some((batch_id, card_ids_json)) = conn
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
    let board_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if board_exists == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }

    let batch_id = uuid::Uuid::now_v7().to_string();
    let mut card_ids = Vec::with_capacity(input.links.len());
    let mut next_y = next_card_y(conn, &input.board_id);

    let tx = conn.transaction()?;
    for link in &input.links {
        let display_url = link.source_url.clone(); // enriched later if needed
                                                   // A user comment becomes the link's description body (authoritative).
        let description = link.description.trim();
        let description_json = if description.is_empty() {
            "{\"type\":\"doc\",\"content\":[]}".to_string()
        } else {
            serde_json::to_string(&serde_json::json!({
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": description }]
                }]
            }))
            .map_err(|e| WorkspaceError::Database(e.to_string()))?
        };

        tx.execute(
            "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
             VALUES (?1, ?2, 'embed', 40, ?3, 320, 240, ?4, 1, ?5, ?5)",
            params![
                link.id,
                input.board_id,
                next_y,
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
            params![link.id, link.source_url, display_url, link.title, description_json, description, description_origin],
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

// --- Quick Boards (persistent references, ADR-0005 entity addressing) ---

/// Lists Quick Boards in persisted order. Only references to active Boards are
/// returned (a trashed/missing Board never renders as a live Quick Board).
pub fn list_quick_boards(conn: &Connection) -> Result<Vec<QuickBoardDto>, WorkspaceError> {
    let mut stmt = conn.prepare(
        "SELECT qb.board_id, b.title, b.color_token, b.symbol, qb.sort_order,
                ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
         FROM quick_boards qb
         JOIN boards b ON b.id = qb.board_id
         LEFT JOIN assets ca ON ca.id = b.cover_asset_id
         WHERE b.deleted_at IS NULL
         ORDER BY qb.sort_order ASC, qb.board_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let cover_asset = if row.get::<_, Option<String>>(5)?.is_some() {
            Some(AssetDto {
                id: row.get(5)?,
                file_name: row.get(6)?,
                mime_type: row.get(7)?,
                width: row.get(8)?,
                height: row.get(9)?,
                size_bytes: row.get(10)?,
                file_path: row.get(11)?,
            })
        } else {
            None
        };
        Ok(QuickBoardDto {
            board_id: row.get(0)?,
            title: row.get(1)?,
            color_token: row.get(2)?,
            symbol: row.get(3)?,
            sort_order: row.get(4)?,
            cover_asset,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Adds a Quick Board reference idempotently. The target Board must be active
/// and non-Home; re-adding an already-pinned Board is a no-op (succeeds).
pub fn add_quick_board(
    conn: &mut Connection,
    input: &AddQuickBoardInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();

    let is_root: i64 = conn.query_row(
        "SELECT COUNT(*) FROM workspaces WHERE root_board_id = ?1",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if is_root > 0 {
        return Err(WorkspaceError::RootBoardProtected);
    }

    let active: i64 = conn.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if active == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }

    // Idempotent: already pinned -> no-op.
    let pinned: i64 = conn.query_row(
        "SELECT COUNT(*) FROM quick_boards WHERE board_id = ?1",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if pinned > 0 {
        return Ok(());
    }

    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM quick_boards",
        [],
        |r| r.get(0),
    )?;

    conn.execute(
        "INSERT INTO quick_boards (board_id, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![input.board_id, next, now],
    )?;
    Ok(())
}

/// Removes a Quick Board reference. Removing an unpinned Board is a no-op.
pub fn remove_quick_board(conn: &mut Connection, board_id: &str) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    // Delete the reference; renumber subsequent positions so the order stays dense.
    let removed = conn
        .prepare("SELECT sort_order FROM quick_boards WHERE board_id = ?1")
        .and_then(|mut stmt| {
            let mut rows = stmt.query([board_id])?;
            if let Some(row) = rows.next()? {
                Ok(row.get::<_, i64>(0)?)
            } else {
                Ok(-1)
            }
        })?;
    if removed < 0 {
        return Ok(()); // no-op
    }

    let tx = conn.transaction()?;
    tx.execute("DELETE FROM quick_boards WHERE board_id = ?1", [board_id])?;
    tx.execute(
        "UPDATE quick_boards SET sort_order = sort_order - 1, updated_at = ?1 WHERE sort_order > ?2",
        params![now, removed],
    )?;
    tx.commit()?;
    Ok(())
}

/// Maximum Unicode scalar values for a search result title/excerpt.
const SEARCH_EXCERPT_LIMIT: usize = 120;

/// Maximum search results returned by the V1 read model.
const SEARCH_RESULT_LIMIT: usize = 50;

fn bound_text(text: &str) -> String {
    text.trim().chars().take(SEARCH_EXCERPT_LIMIT).collect()
}

/// Returns a bounded context snippet centered on the first case-insensitive
/// match of `query`, with ellipses where text is trimmed. Falls back to the
/// start of the text when there is no match.
fn search_excerpt(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    let q = query.to_lowercase();
    let Some(byte_start) = lower.find(&q) else {
        return bound_text(text);
    };

    let chars: Vec<char> = text.chars().collect();
    let match_char_start = text[..byte_start].chars().count();
    let match_char_len = q.chars().count();

    let context_start = match_char_start.saturating_sub(40);
    let context_end = (match_char_start + match_char_len + 40).min(chars.len());

    let mut out = String::new();
    if context_start > 0 {
        out.push('…');
    }
    for ch in &chars[context_start..context_end] {
        out.push(*ch);
    }
    if context_end < chars.len() {
        out.push('…');
    }
    out.trim().to_string()
}

/// Unicode-aware case-insensitive substring test. SQLite's `LIKE` is only
/// case-insensitive for ASCII, so Cyrillic (and other non-ASCII) must be matched
/// in Rust via `to_lowercase`.
fn contains_query(haystack: &str, query_lower: &str) -> bool {
    haystack.to_lowercase().contains(query_lower)
}

/// A search hit plus the rank used to order results deterministically.
struct SearchHit {
    entity_id: String,
    kind: &'static str,
    title: String,
    excerpt: Option<String>,
    board_id: String,
    rank: i64,
    thumbnail_asset: Option<AssetDto>,
    created_at: i64,
}

/// Searches the workspace (Board titles, Note plain text, Link Card title/URL/
/// description) and returns a bounded, deterministic result set. This is the V1
/// default: global scope and a title-before-body ordering; both are documented
/// in `docs/specs/search.md` and may be refined after agreement.
pub fn search_workspace(
    conn: &Connection,
    query: &str,
) -> Result<Vec<SearchResultDto>, WorkspaceError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let q = query.to_lowercase();
    let mut hits = Vec::<SearchHit>::new();

    // Boards by title (rank 0).
    {
        let mut stmt = conn.prepare(
            "SELECT b.id, b.title, b.created_at,
                    ca.id, ca.file_name, ca.mime_type, ca.width, ca.height, ca.size_bytes, ca.file_path
             FROM boards b
             LEFT JOIN assets ca ON ca.id = b.cover_asset_id
             WHERE b.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let cover = if row.get::<_, Option<String>>(3)?.is_some() {
                Some(AssetDto {
                    id: row.get(3)?,
                    file_name: row.get(4)?,
                    mime_type: row.get(5)?,
                    width: row.get(6)?,
                    height: row.get(7)?,
                    size_bytes: row.get(8)?,
                    file_path: row.get(9)?,
                })
            } else {
                None
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                cover,
            ))
        })?;
        for r in rows {
            let (id, title, created_at, cover) = r?;
            if contains_query(&title, &q) {
                hits.push(SearchHit {
                    entity_id: id.clone(),
                    kind: "board",
                    title: bound_text(&title),
                    excerpt: None,
                    board_id: id,
                    rank: 0,
                    thumbnail_asset: cover,
                    created_at,
                });
            }
        }
    }

    // Notes by plain text (rank 1).
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, n.plain_text, c.created_at
             FROM cards c
             JOIN note_cards n ON n.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for r in rows {
            let (id, board_id, plain_text, created_at) = r?;
            if contains_query(&plain_text, &q) {
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "note",
                    title: search_excerpt(&plain_text, query),
                    excerpt: None,
                    board_id,
                    rank: 1,
                    thumbnail_asset: None,
                    created_at,
                });
            }
        }
    }

    // Image cards by caption or file name (rank 1).
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, i.caption_plain_text, c.created_at,
                    a.id, a.file_name, a.mime_type, a.width, a.height, a.size_bytes, a.file_path
             FROM cards c
             JOIN image_cards i ON i.card_id = c.id
             JOIN assets a ON a.id = i.asset_id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let thumb = AssetDto {
                id: row.get(4)?,
                file_name: row.get(5)?,
                mime_type: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                size_bytes: row.get(9)?,
                file_path: row.get(10)?,
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                thumb,
            ))
        })?;
        for r in rows {
            let (id, board_id, caption, created_at, thumb) = r?;
            let file_name = thumb.file_name.clone();
            if contains_query(&caption, &q) || contains_query(&file_name, &q) {
                let title = if caption.trim().is_empty() {
                    file_name
                } else {
                    caption
                };
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "image",
                    title: search_excerpt(&title, query),
                    excerpt: None,
                    board_id,
                    rank: 1,
                    thumbnail_asset: Some(thumb),
                    created_at,
                });
            }
        }
    }

    // Folder shortcuts by display name or the display-only path hint.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, a.display_name, a.path_hint, c.created_at
             FROM cards c
             JOIN filesystem_aliases a ON a.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (id, board_id, display_name, path_hint, created_at) = row?;
            let name_match = contains_query(&display_name, &q);
            let path_match = contains_query(&path_hint, &q);
            if name_match || path_match {
                hits.push(SearchHit {
                    entity_id: id,
                    kind: "folder",
                    title: bound_text(&display_name),
                    excerpt: (!name_match).then(|| bound_text(&path_hint)),
                    board_id,
                    rank: if name_match { 0 } else { 1 },
                    thumbnail_asset: None,
                    created_at,
                });
            }
        }
    }

    // Link Cards (embed) by title, URL, or description.
    {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.board_id, e.title, e.source_url, e.display_url, e.description_plain_text,
                    pa.id, pa.file_name, pa.mime_type, pa.width, pa.height, pa.size_bytes, pa.file_path,
                    fa.id, fa.file_name, fa.mime_type, fa.width, fa.height, fa.size_bytes, fa.file_path,
                    c.created_at
             FROM cards c
             JOIN embed_cards e ON e.card_id = c.id
             JOIN boards b ON b.id = c.board_id AND b.deleted_at IS NULL
             LEFT JOIN assets pa ON pa.id = e.asset_id
             LEFT JOIN assets fa ON fa.id = e.favicon_asset_id
             WHERE c.deleted_at IS NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            let preview = if row.get::<_, Option<String>>(6)?.is_some() {
                Some(AssetDto {
                    id: row.get(6)?,
                    file_name: row.get(7)?,
                    mime_type: row.get(8)?,
                    width: row.get(9)?,
                    height: row.get(10)?,
                    size_bytes: row.get(11)?,
                    file_path: row.get(12)?,
                })
            } else {
                None
            };
            let favicon = if row.get::<_, Option<String>>(13)?.is_some() {
                Some(AssetDto {
                    id: row.get(13)?,
                    file_name: row.get(14)?,
                    mime_type: row.get(15)?,
                    width: row.get(16)?,
                    height: row.get(17)?,
                    size_bytes: row.get(18)?,
                    file_path: row.get(19)?,
                })
            } else {
                None
            };
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                preview.or(favicon),
                row.get::<_, i64>(20)?,
            ))
        })?;
        for r in rows {
            let (id, board_id, title_raw, source_url, display_url, description, thumb, created_at) =
                r?;
            let title = title_raw
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| source_url.clone());

            let title_match = contains_query(&title, &q);
            let source_match = contains_query(&source_url, &q);
            let display_match = contains_query(&display_url, &q);
            let desc_match = contains_query(&description, &q);

            if !(title_match || source_match || display_match || desc_match) {
                continue;
            }

            let (rank, excerpt) = if title_match || source_match || display_match {
                (0, None)
            } else {
                (2, Some(search_excerpt(&description, query)))
            };

            hits.push(SearchHit {
                entity_id: id,
                kind: "link",
                title,
                excerpt,
                board_id,
                rank,
                thumbnail_asset: thumb,
                created_at,
            });
        }
    }

    // Deterministic ordering: rank first, then title, then entity id.
    hits.sort_by(|a, b| {
        a.rank
            .cmp(&b.rank)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });
    hits.truncate(SEARCH_RESULT_LIMIT);

    // Fetch each board's identity once, so results carry the same cover/icon/
    // acronym fallback as the rest of the UI (no duplicated identity logic).
    let mut identity_cache: std::collections::HashMap<
        String,
        (String, Option<String>, Option<AssetDto>),
    > = std::collections::HashMap::new();
    for hit in &hits {
        if identity_cache.contains_key(&hit.board_id) {
            continue;
        }
        let summary = load_board_summary(conn, &hit.board_id)?;
        identity_cache.insert(
            hit.board_id.clone(),
            (summary.color_token, summary.symbol, summary.cover_asset),
        );
    }

    let mut out = Vec::with_capacity(hits.len());
    for hit in hits {
        let board_trail = load_breadcrumbs(conn, &hit.board_id)?;
        let (board_color_token, board_symbol, board_cover_asset) = identity_cache
            .get(&hit.board_id)
            .cloned()
            .unwrap_or((String::new(), None, None));
        out.push(SearchResultDto {
            entity_id: hit.entity_id,
            kind: hit.kind.to_string(),
            title: hit.title,
            excerpt: hit.excerpt,
            board_id: hit.board_id,
            board_trail,
            board_color_token,
            board_symbol,
            board_cover_asset,
            thumbnail_asset: hit.thumbnail_asset,
            created_at: hit.created_at,
        });
    }
    Ok(out)
}
/// must contain exactly the currently-pinned Board ids (no missing/extra ids),
/// otherwise the operation is rejected without partial writes.
pub fn reorder_quick_boards(
    conn: &mut Connection,
    input: &ReorderQuickBoardsInput,
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let tx = conn.transaction()?;

    let current_count: i64 = tx.query_row("SELECT COUNT(*) FROM quick_boards", [], |r| r.get(0))?;
    if current_count as usize != input.board_ids.len() {
        return Err(WorkspaceError::ConstraintViolation(
            "reorder must include every pinned board exactly once".to_string(),
        ));
    }

    for (i, board_id) in input.board_ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE quick_boards SET sort_order = ?1, updated_at = ?2 WHERE board_id = ?3",
            params![i as i64, now, board_id],
        )?;
        if changed == 0 {
            return Err(WorkspaceError::NotFound(board_id.clone()));
        }
    }

    tx.commit()?;
    Ok(())
}
