//! Коннекторы: стрелки между двумя живыми карточками холста одной доски.
//!
//! Коннектор — отдельная синхронизируемая сущность (`connectors`, миграция
//! 0027). Его жизненный цикл следует за концами; хелперы ниже вызывают пути
//! корзины, переноса и дублирования внутри своей транзакции:
//!
//! - корзина карточки мягко удаляет её коннекторы с тем же батчем
//!   ([`trash_connectors_of_batch`]); восстановление батча возвращает их
//!   ([`restore_connectors_of_batch`]);
//! - физически строка исчезает только FK-каскадом от стёртой карточки или
//!   доски: у тех есть purge-тумбстоун, так что поздние строки коннектора
//!   отбрасываются при реплее. Любое другое удаление мягкое, иначе устройство,
//!   не видевшее стирания, вернуло бы строку с устаревшим `body`. Мягко
//!   удалённые коннекторы между живыми карточками остаются скрытыми строками;
//! - удаление пользователем тоже мягкое ([`remove_connector`]): undo/redo
//!   фронта сцепляет ревизии через квитанции, и пересоздание строки с
//!   ревизией 1 сделало бы старые записи undo устаревшими; повторный
//!   `create_connector` с тем же id восстанавливает строку;
//! - карточка, ушедшая с холста доски (на другую доску или в Unsorted),
//!   мягко теряет коннекторы ([`delete_connectors_touching`]);
//! - копия доски получает копии коннекторов с переназначенными концами
//!   ([`copy_board_connectors`]).

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::domain::errors::WorkspaceError;
use crate::domain::models::{ConnectorDto, CreateConnectorInput, UpdateConnectorInput};

use super::super::db;
use super::immediate_tx;

/// Допустимые цвета коннектора (пресеты цвета заметки, миграция 0011).
pub const CONNECTOR_COLOR_TOKENS: &[&str] = &[
    "default", "yellow", "pink", "lavender", "blue", "green", "gray",
];
/// Допустимые положения наконечников.
pub const CONNECTOR_ARROW_ENDS: &[&str] = &["end", "both", "none"];

const COLUMNS: &str = "k.id, k.board_id, k.from_card_id, k.to_card_id, k.color_token,
     k.arrow_ends, k.label, k.revision, k.created_at, k.updated_at";

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectorDto> {
    Ok(ConnectorDto {
        id: row.get(0)?,
        board_id: row.get(1)?,
        from_card_id: row.get(2)?,
        to_card_id: row.get(3)?,
        color_token: row.get(4)?,
        arrow_ends: row.get(5)?,
        label: row.get(6)?,
        revision: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// Один коннектор по id, в любом состоянии корзины.
pub fn load_connector(
    conn: &Connection,
    connector_id: &str,
) -> Result<Option<ConnectorDto>, WorkspaceError> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM connectors k WHERE k.id = ?1"),
            [connector_id],
            map_row,
        )
        .optional()?)
}

/// Коннекторы снимка доски: не удалены, и оба конца — живые карточки холста
/// доски коннектора.
pub fn load_board_connectors(
    conn: &Connection,
    board_id: &str,
) -> Result<Vec<ConnectorDto>, WorkspaceError> {
    // Строка коннектора может пережить свой конец: восстановлена из корзины,
    // пока второй конец ещё там, или пришла из реплея после переноса карточки.
    // Такой коннектор не удаляется, а просто не показывается, пока оба конца
    // снова не окажутся живыми на холсте этой доски.
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM connectors k
         JOIN cards f ON f.id = k.from_card_id
         JOIN cards t ON t.id = k.to_card_id
         WHERE k.board_id = ?1 AND k.deleted_at IS NULL
           AND f.board_id = k.board_id AND f.deleted_at IS NULL AND f.unsorted = 0
           AND t.board_id = k.board_id AND t.deleted_at IS NULL AND t.unsorted = 0
         ORDER BY k.created_at, k.id"
    ))?;
    let rows = stmt.query_map([board_id], map_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn validate_token(value: &str, allowed: &[&str], what: &str) -> Result<(), WorkspaceError> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(WorkspaceError::ConstraintViolation(format!(
            "unknown connector {what}: {value}"
        )))
    }
}

/// Оба конца — разные живые карточки холста доски `board_id`.
fn validate_endpoints(
    conn: &Connection,
    board_id: &str,
    from_card_id: &str,
    to_card_id: &str,
) -> Result<(), WorkspaceError> {
    if from_card_id == to_card_id {
        return Err(WorkspaceError::ConstraintViolation(
            "a connector cannot link a card to itself".to_string(),
        ));
    }
    for card_id in [from_card_id, to_card_id] {
        let on_canvas: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards
             WHERE id = ?1 AND board_id = ?2 AND deleted_at IS NULL AND unsorted = 0",
            params![card_id, board_id],
            |r| r.get(0),
        )?;
        if on_canvas == 0 {
            return Err(WorkspaceError::ConstraintViolation(format!(
                "card {card_id} is not a live card on the connector's board"
            )));
        }
    }
    Ok(())
}

/// Создаёт коннектор. Идемпотентно по id: живая строка возвращается как
/// есть, мягко удалённая восстанавливается (ревизия и сохранённые поля, в том
/// числе подпись, остаются, цвет и наконечники из ввода игнорируются).
pub fn create_connector(
    conn: &mut Connection,
    input: &CreateConnectorInput,
) -> Result<ConnectorDto, WorkspaceError> {
    let color_token = input.color_token.as_deref().unwrap_or("default");
    let arrow_ends = input.arrow_ends.as_deref().unwrap_or("end");
    validate_token(color_token, CONNECTOR_COLOR_TOKENS, "color")?;
    validate_token(arrow_ends, CONNECTOR_ARROW_ENDS, "arrow ends")?;
    let now = db::migrations::now_millis();

    // BEGIN IMMEDIATE до проверок: проверки и вставка атомарны относительно
    // другого процесса-писателя.
    let tx = immediate_tx(conn)?;

    let deleted: Option<Option<i64>> = tx
        .query_row(
            "SELECT deleted_at FROM connectors WHERE id = ?1",
            [input.id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(deleted_at) = deleted {
        if deleted_at.is_some() {
            // Undo удаления: та же строка с той же ревизией, чтобы квитанции
            // фронта для последующих правок оставались верными.
            tx.execute(
                "UPDATE connectors SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ?2
                 WHERE id = ?1",
                params![input.id, now],
            )?;
        }
        let existing = load_connector(&tx, &input.id)?
            .ok_or_else(|| WorkspaceError::NotFound(input.id.clone()))?;
        tx.commit()?;
        return Ok(existing);
    }

    let board_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM boards WHERE id = ?1 AND deleted_at IS NULL",
        [input.board_id.as_str()],
        |r| r.get(0),
    )?;
    if board_exists == 0 {
        return Err(WorkspaceError::NotFound(input.board_id.clone()));
    }
    validate_endpoints(&tx, &input.board_id, &input.from_card_id, &input.to_card_id)?;

    tx.execute(
        "INSERT INTO connectors (id, board_id, from_card_id, to_card_id, color_token, arrow_ends,
                                 revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)",
        params![
            input.id,
            input.board_id,
            input.from_card_id,
            input.to_card_id,
            color_token,
            arrow_ends,
            now
        ],
    )?;
    let created = load_connector(&tx, &input.id)?
        .ok_or_else(|| WorkspaceError::NotFound(input.id.clone()))?;
    tx.commit()?;
    Ok(created)
}

/// Правит живой коннектор под проверкой `expected_revision` и возвращает его
/// с новой ревизией.
pub fn update_connector(
    conn: &mut Connection,
    input: &UpdateConnectorInput,
) -> Result<ConnectorDto, WorkspaceError> {
    if let Some(color) = &input.color_token {
        validate_token(color, CONNECTOR_COLOR_TOKENS, "color")?;
    }
    if let Some(ends) = &input.arrow_ends {
        validate_token(ends, CONNECTOR_ARROW_ENDS, "arrow ends")?;
    }
    let now = db::migrations::now_millis();
    let tx = immediate_tx(conn)?;

    // Удалённый коннектор не редактируется: его нет на холсте.
    let current = tx
        .query_row(
            &format!("SELECT {COLUMNS} FROM connectors k WHERE k.id = ?1 AND k.deleted_at IS NULL"),
            [input.connector_id.as_str()],
            map_row,
        )
        .optional()?
        .ok_or_else(|| WorkspaceError::NotFound(input.connector_id.clone()))?;
    if current.revision != input.expected_revision {
        return Err(WorkspaceError::StaleRevision {
            expected: input.expected_revision,
            actual: current.revision,
        });
    }

    let from_card_id = input.from_card_id.as_ref().unwrap_or(&current.from_card_id);
    let to_card_id = input.to_card_id.as_ref().unwrap_or(&current.to_card_id);
    if input.from_card_id.is_some() || input.to_card_id.is_some() {
        validate_endpoints(&tx, &current.board_id, from_card_id, to_card_id)?;
    }
    let label = match &input.label {
        Some(label) => label.clone(),
        None => current.label.clone(),
    };

    tx.execute(
        "UPDATE connectors
         SET from_card_id = ?2, to_card_id = ?3, color_token = ?4, arrow_ends = ?5, label = ?6,
             revision = revision + 1, updated_at = ?7
         WHERE id = ?1",
        params![
            input.connector_id,
            from_card_id,
            to_card_id,
            input.color_token.as_ref().unwrap_or(&current.color_token),
            input.arrow_ends.as_ref().unwrap_or(&current.arrow_ends),
            label,
            now
        ],
    )?;
    let updated = load_connector(&tx, &input.connector_id)?
        .ok_or_else(|| WorkspaceError::NotFound(input.connector_id.clone()))?;
    tx.commit()?;
    Ok(updated)
}

/// Мягко удаляет коннектор вне батча корзины (ревизия не меняется). Нет
/// такого id — no-op, чтобы цепочки undo/redo не падали. Уже удалённый с
/// корзиной конца коннектор теряет батч: иначе undo «соединить карточки»,
/// пока конец в корзине, откатил бы Restore этого конца.
pub fn remove_connector(conn: &mut Connection, connector_id: &str) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    conn.execute(
        "UPDATE connectors
         SET deleted_at = COALESCE(deleted_at, ?2), trash_batch_id = NULL, updated_at = ?2
         WHERE id = ?1 AND (deleted_at IS NULL OR trash_batch_id IS NOT NULL)",
        params![connector_id, now],
    )?;
    Ok(())
}

/// Мягко удаляет каждый живой коннектор карточек батча `batch_id` с тем же
/// батчем и `deleted_at`. Вызывается в транзакции корзины после пометки
/// карточек.
pub fn trash_connectors_of_batch(
    conn: &Connection,
    batch_id: &str,
    deleted_at: i64,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE connectors SET deleted_at = ?2, trash_batch_id = ?1, updated_at = ?2
         WHERE deleted_at IS NULL
           AND (from_card_id IN (SELECT id FROM cards WHERE trash_batch_id = ?1)
             OR to_card_id IN (SELECT id FROM cards WHERE trash_batch_id = ?1))",
        params![batch_id, deleted_at],
    )?;
    Ok(())
}

/// Восстанавливает коннекторы батча `batch_id`. Если второй конец ещё в
/// корзине, [`load_board_connectors`] прячет коннектор, пока не вернётся и он.
pub fn restore_connectors_of_batch(
    conn: &Connection,
    batch_id: &str,
) -> Result<(), WorkspaceError> {
    conn.execute(
        "UPDATE connectors SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ?2
         WHERE trash_batch_id = ?1",
        params![batch_id, db::migrations::now_millis()],
    )?;
    Ok(())
}

/// Мягко удаляет коннекторы карточек из `card_ids`, которых больше нет на
/// холсте доски коннектора (другая доска или Unsorted), и снимает с них батч
/// корзины, чтобы Restore их не вернул. Вызывается после переноса в его
/// транзакции; карточка, оставшаяся на месте, коннекторы сохраняет.
pub fn delete_connectors_touching(
    conn: &Connection,
    card_ids: &[&str],
) -> Result<(), WorkspaceError> {
    let now = db::migrations::now_millis();
    let mut stmt = conn.prepare_cached(
        "UPDATE connectors
         SET deleted_at = COALESCE(deleted_at, ?2), trash_batch_id = NULL, updated_at = ?2
         WHERE (from_card_id = ?1 OR to_card_id = ?1)
           AND (deleted_at IS NULL OR trash_batch_id IS NOT NULL)
           AND EXISTS (
               SELECT 1 FROM cards c
               WHERE c.id = ?1 AND (c.board_id <> connectors.board_id OR c.unsorted <> 0)
           )",
    )?;
    for card_id in card_ids {
        stmt.execute(params![card_id, now])?;
    }
    Ok(())
}

/// Копирует живые коннекторы `source_board_id` на `new_board_id`, переводя
/// концы через `card_ids` (id исходной карточки → id копии). Коннектор с
/// нескопированным концом пропускается.
pub fn copy_board_connectors(
    conn: &Connection,
    source_board_id: &str,
    new_board_id: &str,
    card_ids: &HashMap<String, String>,
    now: i64,
) -> Result<(), WorkspaceError> {
    let source: Vec<(String, String, String, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT from_card_id, to_card_id, color_token, arrow_ends, label
             FROM connectors WHERE board_id = ?1 AND deleted_at IS NULL
             ORDER BY created_at, id",
        )?;
        let rows = stmt.query_map([source_board_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    for (from, to, color_token, arrow_ends, label) in source {
        let (Some(new_from), Some(new_to)) = (card_ids.get(&from), card_ids.get(&to)) else {
            continue;
        };
        conn.execute(
            "INSERT INTO connectors (id, board_id, from_card_id, to_card_id, color_token,
                                     arrow_ends, label, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
            params![
                uuid::Uuid::now_v7().to_string(),
                new_board_id,
                new_from,
                new_to,
                color_token,
                arrow_ends,
                label,
                now
            ],
        )?;
    }
    Ok(())
}
