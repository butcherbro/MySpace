//! Группы на холсте (ADR-0013): создание и правка карточки вида `group`.
//! Перемещение, ресайз, корзина, перенос и копирование идут общими путями
//! карточек; здесь только то, что специфично для группы, — имя и цвет.

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::card_kind::{handler, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, CardReceipt, CreateGroupInput, UpdateGroupInput};

use super::super::db;
use super::cards::card_receipt;
use super::immediate_tx;

/// Допустимые цвета группы — палитра заметки (миграции 0011, 0028).
pub const GROUP_COLOR_TOKENS: &[&str] = &[
    "default", "yellow", "pink", "lavender", "blue", "green", "gray",
];

/// Максимальная длина имени группы в символах (не байтах).
pub const GROUP_TITLE_MAX_CHARS: usize = 200;

fn validate_color(token: &str) -> Result<(), WorkspaceError> {
    if GROUP_COLOR_TOKENS.contains(&token) {
        Ok(())
    } else {
        Err(WorkspaceError::ConstraintViolation(format!(
            "unknown group color: {token}"
        )))
    }
}

// Бэкенд хранит имя как пришло и сам не обрезает: trim делает фронт перед
// отправкой, так что MCP и реплей получают ровно сохранённую строку.
fn validate_title(title: &str) -> Result<(), WorkspaceError> {
    if title.chars().count() > GROUP_TITLE_MAX_CHARS {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "group title must be at most {GROUP_TITLE_MAX_CHARS} characters"
        )));
    }
    Ok(())
}

fn load_group_card(conn: &Connection, card_id: &str) -> Result<CardDto, WorkspaceError> {
    handler(CardKind::Group)
        .load_one(conn, card_id)?
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))
}

/// Создаёт группу. Идемпотентно по id (как `create_board_shortcut`):
/// повтор возвращает сохранённую карточку, а не ошибку.
pub fn create_group(
    conn: &mut Connection,
    input: &CreateGroupInput,
) -> Result<CardDto, WorkspaceError> {
    input.frame.validate()?;
    let title = input.title.as_deref().unwrap_or("");
    let color_token = input.color_token.as_deref().unwrap_or("default");
    validate_title(title)?;
    validate_color(color_token)?;
    let now = db::migrations::now_millis();

    // BEGIN IMMEDIATE до проверок: проверка доски, повтор и вставка атомарны.
    let tx = immediate_tx(conn)?;
    // Без этой проверки FK пропустил бы группу на доске в корзине.
    let board_live: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if board_live == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }

    let existing_kind: Option<String> = tx
        .query_row(
            "SELECT kind FROM cards WHERE id = ?1",
            [input.id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(kind) = existing_kind {
        if kind == CardKind::Group.as_str() {
            return load_group_card(&tx, &input.id);
        }
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {} already exists with a different kind",
            input.id
        )));
    }

    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
        params![
            input.id,
            input.board_id,
            CardKind::Group.as_str(),
            input.frame.x,
            input.frame.y,
            input.frame.width,
            input.frame.height,
            input.z_index,
            now,
        ],
    )?;
    tx.execute(
        "INSERT INTO group_cards (card_id, title, color_token) VALUES (?1, ?2, ?3)",
        params![input.id, title, color_token],
    )?;
    tx.commit()?;

    load_group_card(conn, &input.id)
}

/// Меняет имя и/или цвет живой группы под проверкой `expected_revision`
/// и поднимает ревизию карточки.
pub fn update_group(
    conn: &mut Connection,
    input: &UpdateGroupInput,
) -> Result<CardReceipt, WorkspaceError> {
    if input.title.is_none() && input.color_token.is_none() {
        return Err(WorkspaceError::ConstraintViolation(
            "update_group needs a title or a color".to_string(),
        ));
    }
    if let Some(title) = &input.title {
        validate_title(title)?;
    }
    if let Some(color) = &input.color_token {
        validate_color(color)?;
    }
    let now = db::migrations::now_millis();

    let tx = immediate_tx(conn)?;
    // Удалённая (в корзине) группа не редактируется: её нет на холсте.
    let revision: i64 = tx
        .query_row(
            "SELECT revision FROM cards WHERE id = ?1 AND kind = ?2 AND deleted_at IS NULL",
            params![input.card_id, CardKind::Group.as_str()],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.card_id.clone()))?;
    if revision != input.expected_revision {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual: revision,
        });
    }

    tx.execute(
        "UPDATE cards SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
        params![now, input.card_id],
    )?;
    tx.execute(
        "UPDATE group_cards
         SET title = COALESCE(?1, title), color_token = COALESCE(?2, color_token)
         WHERE card_id = ?3",
        params![input.title, input.color_token, input.card_id],
    )?;

    let receipt = card_receipt(&tx, &input.card_id)?;
    tx.commit()?;
    Ok(receipt)
}
