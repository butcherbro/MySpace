//! Tauri-команды коннекторов: стрелки между двумя карточками доски.

use tauri::State;

use crate::app::Workspace;
use crate::domain::errors::WorkspaceError;
use crate::domain::models::{ConnectorDto, CreateConnectorInput, UpdateConnectorInput};
use crate::domain::mutation::Mutation;
use crate::telemetry::instrument_async;

/// Создаёт коннектор (идемпотентно по id, удалённый восстанавливает) и
/// возвращает сохранённую строку.
#[tauri::command]
pub async fn create_connector(
    ws: State<'_, Workspace>,
    input: CreateConnectorInput,
) -> Result<ConnectorDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("create_connector", async move {
        ws.apply(Mutation::CreateConnector(input))
            .await?
            .into_connector()
    })
    .await
}

/// Правит коннектор под ожидаемой ревизией и возвращает новую строку.
#[tauri::command]
pub async fn update_connector(
    ws: State<'_, Workspace>,
    input: UpdateConnectorInput,
) -> Result<ConnectorDto, WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("update_connector", async move {
        ws.apply(Mutation::UpdateConnector(input))
            .await?
            .into_connector()
    })
    .await
}

/// Мягко удаляет коннектор; неизвестный id — no-op.
#[tauri::command]
pub async fn remove_connector(
    ws: State<'_, Workspace>,
    connector_id: String,
) -> Result<(), WorkspaceError> {
    let ws = ws.inner().clone();
    instrument_async("remove_connector", async move {
        ws.apply(Mutation::RemoveConnector { connector_id })
            .await?
            .into_unit()
    })
    .await
}
