//! Tauri-команды групп на холсте (ADR-0013): создание и правка имени/цвета.
//! Перемещение, ресайз и корзина группы идут общими командами карточек.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardDto, CardReceipt, CreateGroupInput, UpdateGroupInput};
use crate::domain::mutation::Mutation;
use crate::telemetry::instrument_async;

/// Создаёт группу (идемпотентно по id) и возвращает сохранённую карточку.
#[tauri::command]
pub async fn create_group(
    ws: State<'_, Workspace>,
    input: CreateGroupInput,
) -> Result<CardDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_group", async move {
        ws.apply(Mutation::CreateGroup(input)).await?.into_card()
    })
    .await
}

/// Меняет имя и/или цвет группы под ожидаемой ревизией.
#[tauri::command]
pub async fn update_group(
    ws: State<'_, Workspace>,
    input: UpdateGroupInput,
) -> Result<CardReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("update_group", async move {
        ws.apply(Mutation::UpdateGroup(input))
            .await?
            .into_card_receipt()
    })
    .await
}
