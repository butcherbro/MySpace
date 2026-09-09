//! Tauri boundary for folder shortcuts. Resolved paths never cross into JS.
use crate::{
    domain::{
        errors::WorkspaceError,
        filesystem_alias_service::{self, FolderLocator},
        models::{CreateFilesystemAliasInput, FilesystemAliasDto, FolderPreviewDto},
    },
    repositories::workspace_repository,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;

pub type DbState<'a> = State<'a, Mutex<Connection>>;
#[cfg(target_os = "macos")]
type PlatformLocator = filesystem_alias_service::MacosBookmarkLocator;
#[cfg(not(target_os = "macos"))]
type PlatformLocator = filesystem_alias_service::UnsupportedPlatformLocator;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderAliasCommandInput {
    pub id: String,
    pub board_id: String,
    pub frame: crate::domain::models::Frame,
    pub z_index: i64,
    pub source_path: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedDrop {
    pub path: String,
    pub kind: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
}

#[tauri::command]
pub fn create_folder_alias(
    db: DbState<'_>,
    input: CreateFolderAliasCommandInput,
) -> Result<FilesystemAliasDto, WorkspaceError> {
    let path = PathBuf::from(&input.source_path);
    if !path.is_dir() {
        return Err(WorkspaceError::ConstraintViolation(
            "folder alias target must be an existing directory".into(),
        ));
    }
    let display_name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("Folder")
        .to_string();
    let locator = PlatformLocator::default();
    let locator_blob = locator.create(&path).map_err(|_| {
        WorkspaceError::ConstraintViolation("could not create folder locator".into())
    })?;
    let model = CreateFilesystemAliasInput {
        id: input.id,
        board_id: input.board_id,
        frame: input.frame,
        z_index: input.z_index,
        target_kind: "folder".into(),
        locator_blob,
        path_hint: path.to_string_lossy().into_owned(),
        display_name,
    };
    let mut conn = db
        .lock()
        .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::create_filesystem_alias(&mut conn, &model)?;
    Ok(FilesystemAliasDto {
        id: model.id,
        board_id: model.board_id,
        frame: model.frame,
        z_index: model.z_index,
        revision: 1,
        target_kind: model.target_kind,
        path_hint: model.path_hint,
        display_name: model.display_name,
    })
}
#[tauri::command]
pub fn list_folder_preview(
    db: DbState<'_>,
    card_id: String,
    limit: usize,
) -> Result<FolderPreviewDto, WorkspaceError> {
    // Load the locator under the lock, then drop it: filesystem I/O must never
    // block snapshot reads on the shared SQLite connection.
    let (blob, hint, name) = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        workspace_repository::load_filesystem_alias_locator(&conn, &card_id)?
    };
    let locator = PlatformLocator::default();
    let (preview, refreshed, path) =
        filesystem_alias_service::list_preview_with_refresh(&locator, &blob, &hint, &name, limit);
    if let (Some(blob), Some(path)) = (refreshed, path) {
        let path_hint = path.to_string_lossy().into_owned();
        let display_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&name)
            .to_owned();
        let mut conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        workspace_repository::refresh_filesystem_alias_locator(
            &mut conn,
            &card_id,
            &blob,
            &path_hint,
            &display_name,
        )?;
    }
    Ok(preview)
}
fn mime_for_ext(ext: Option<&str>) -> Option<String> {
    ext.and_then(|e| {
        match e.to_ascii_lowercase().as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "webp" => Some("image/webp"),
            "heic" => Some("image/heic"),
            "svg" => Some("image/svg+xml"),
            _ => None,
        }
        .map(str::to_owned)
    })
}

#[tauri::command]
pub fn classify_drop_paths(paths: Vec<String>) -> Vec<ClassifiedDrop> {
    paths
        .into_iter()
        .map(|path| {
            let ext = Path::new(&path)
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_owned);
            let file_name = Path::new(&path)
                .file_name()
                .and_then(|v| v.to_str())
                .map(str::to_owned);
            let kind = if Path::new(&path).is_dir() {
                "folder"
            } else if matches!(
                ext.as_deref().map(|e| e.to_ascii_lowercase()).as_deref(),
                Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg")
            ) {
                "image"
            } else {
                "unsupported"
            };
            let mime_type = if kind == "image" {
                mime_for_ext(ext.as_deref())
            } else {
                None
            };
            ClassifiedDrop {
                path,
                kind: kind.into(),
                file_name,
                mime_type,
            }
        })
        .collect()
}
#[tauri::command]
pub fn open_folder_in_finder(db: DbState<'_>, card_id: String) -> Result<(), WorkspaceError> {
    let blob = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        let (blob, _, _) = workspace_repository::load_filesystem_alias_locator(&conn, &card_id)?;
        blob
    };
    let locator = PlatformLocator::default();
    let resolved = locator
        .resolve(&blob)
        .map_err(|_| WorkspaceError::NotFound(card_id))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&resolved.path)
        .status()
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let _ = resolved;
    Ok(())
}
