//! Tauri-команды групп на холсте (ADR-0013): создание и правка имени/цвета.
//! Перемещение, ресайз и корзина группы идут общими командами карточек.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{CardReceipt, CreateGroupInput, GroupCreatedReceipt, UpdateGroupInput};
use crate::domain::mutation::Mutation;
use crate::telemetry::instrument_async;

/// Создаёт группу (идемпотентно по id) вместе с участниками `member_ids` и
/// возвращает сохранённую карточку плюс ревизии участников.
#[tauri::command]
pub async fn create_group(
    ws: State<'_, Workspace>,
    input: CreateGroupInput,
) -> Result<GroupCreatedReceipt, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_group", async move {
        ws.apply(Mutation::CreateGroup(input))
            .await?
            .into_group_created()
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
