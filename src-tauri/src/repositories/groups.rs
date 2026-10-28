//! Группы на холсте (ADR-0013): создание и правка карточки вида `group`.
//! Перемещение, ресайз, корзина, перенос и копирование идут общими путями
//! карточек; здесь то, что специфично для группы, — имя, цвет и проверка
//! членства (`cards.group_id`), общая для `create_group` и `move_cards`.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::card_kind::{handler, CardKind};
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{
    CardDto, CardReceipt, CreateGroupInput, GroupCreatedReceipt, UpdateGroupInput,
};

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

/// Проверяет, что карточка `card_id` с доски `card_board_id` может войти в
/// группу `group_id`: группа существует, живая (не в корзине и не в
/// Unsorted), вида `group`, на той же доске, это не сама карточка и карточка
/// не предок группы. Ошибка — `ConstraintViolation`, как у коннектора с
/// плохим концом.
pub(super) fn validate_group_assignment(
    tx: &Connection,
    card_id: &str,
    card_board_id: &str,
    group_id: &str,
) -> Result<(), WorkspaceError> {
    if card_id == group_id {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {card_id} cannot be its own group"
        )));
    }
    let on_board: i64 = tx.query_row(
        "SELECT COUNT(*) FROM cards
         WHERE id = ?1 AND kind = ?2 AND board_id = ?3 AND deleted_at IS NULL AND unsorted = 0",
        params![group_id, CardKind::Group.as_str(), card_board_id],
        |r| r.get(0),
    )?;
    if on_board == 0 {
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {group_id} is not a live group on the board of card {card_id}"
        )));
    }
    // Подъём по хранимой цепочке group_id от цели: встретили саму карточку —
    // цикл. Хранимые данные могут быть битыми (висячая ссылка, цикл после
    // реплея), поэтому обход останавливается на NULL, на пропавшей строке и
    // на уже посещённом id.
    let mut visited: HashSet<String> = HashSet::new();
    let mut current = Some(group_id.to_string());
    while let Some(id) = current {
        if id == card_id {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card {card_id} is an ancestor of group {group_id}"
            )));
        }
        if !visited.insert(id.clone()) {
            break;
        }
        current = tx
            .query_row("SELECT group_id FROM cards WHERE id = ?1", [&id], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()?
            .flatten();
    }
    Ok(())
}

fn load_group_card(conn: &Connection, card_id: &str) -> Result<CardDto, WorkspaceError> {
    handler(CardKind::Group)
        .load_one(conn, card_id)?
        .ok_or_else(|| WorkspaceError::NotFound(card_id.to_string()))
}

/// Создаёт группу и в той же транзакции записывает её в `group_id` каждой
/// карточке из `member_ids` (с подъёмом ревизии). Идемпотентно по id (как
/// `create_board_shortcut`): повтор возвращает сохранённую карточку и пустой
/// список участников, а не ошибку.
pub fn create_group(
    conn: &mut Connection,
    input: &CreateGroupInput,
) -> Result<GroupCreatedReceipt, WorkspaceError> {
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
            return Ok(GroupCreatedReceipt {
                group: load_group_card(&tx, &input.id)?,
                members: Vec::new(),
            });
        }
        return Err(WorkspaceError::ConstraintViolation(format!(
            "card {} already exists with a different kind",
            input.id
        )));
    }

    // Своя группа новой рамки (вложенная группа). Цикл для нового id
    // невозможен, но проверка общая с `move_cards`.
    if let Some(group_id) = &input.group_id {
        validate_group_assignment(&tx, &input.id, &input.board_id, group_id)?;
    }
    tx.execute(
        "INSERT INTO cards (id, board_id, kind, x, y, width, height, z_index, revision, created_at, updated_at, group_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9, ?10)",
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
            input.group_id,
        ],
    )?;
    tx.execute(
        "INSERT INTO group_cards (card_id, title, color_token) VALUES (?1, ?2, ?3)",
        params![input.id, title, color_token],
    )?;

    // Участники проверяются после вставки группы: проверка цели видит её
    // живой. Любая ошибка откатывает транзакцию — группа не создаётся.
    let mut seen: HashSet<&str> = HashSet::new();
    let mut members = Vec::new();
    for member_id in &input.member_ids {
        if !seen.insert(member_id.as_str()) {
            continue;
        }
        if member_id == &input.id {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "group {member_id} cannot be its own member"
            )));
        }
        let on_board: i64 = tx.query_row(
            "SELECT COUNT(*) FROM cards
             WHERE id = ?1 AND board_id = ?2 AND deleted_at IS NULL AND unsorted = 0",
            params![member_id, input.board_id],
            |r| r.get(0),
        )?;
        if on_board == 0 {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card {member_id} is not a live card on the group's board"
            )));
        }
        validate_group_assignment(&tx, member_id, &input.board_id, &input.id)?;
        tx.execute(
            "UPDATE cards SET group_id = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
            params![input.id, now, member_id],
        )?;
        members.push(card_receipt(&tx, member_id)?);
    }
    tx.commit()?;

    Ok(GroupCreatedReceipt {
        group: load_group_card(conn, &input.id)?,
        members,
    })
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
