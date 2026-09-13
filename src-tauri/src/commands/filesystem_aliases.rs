//! Tauri boundary for folder shortcuts and file cards. Resolved paths never cross into JS.
use crate::{
    domain::{
        asset_service,
        errors::WorkspaceError,
        filesystem_alias_service::{self, FolderLocator, LocatorError},
        models::{
            CreateFileCardInput, CreateFilesystemAliasInput, FileCardDto, FilesystemAliasDto,
            FolderPreviewDto,
        },
    },
    repositories::workspace_repository,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};

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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileCardCommandInput {
    pub id: String,
    pub board_id: String,
    pub frame: crate::domain::models::Frame,
    pub z_index: i64,
    pub source_path: String,
    pub mime_type: String,
    pub file_name: String,
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
    let locator_blob = locator.create(&path).map_err(|error| {
        WorkspaceError::ConstraintViolation(format!("could not create folder locator: {error}"))
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
#[tauri::command]
pub fn classify_drop_paths(paths: Vec<String>) -> Vec<ClassifiedDrop> {
    paths
        .into_iter()
        .map(|path| {
            let (kind, file_name, mime_type) =
                filesystem_alias_service::classify_drop(Path::new(&path));
            ClassifiedDrop {
                path,
                kind,
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
    let resolved = locator.resolve(&blob).map_err(|error| match error {
        LocatorError::Missing => WorkspaceError::NotFound(card_id),
        LocatorError::PermissionLost => WorkspaceError::ConstraintViolation(
            "folder shortcut permission was lost; drop the folder again".into(),
        ),
        LocatorError::Io(message) => {
            WorkspaceError::Database(format!("could not open folder shortcut: {message}"))
        }
    })?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&resolved.path)
        .status()
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let _ = resolved;
    Ok(())
}

/// Copies a dropped text-like file into the managed asset store, reads a bounded
/// preview, and creates the File Card. All slow work (copy, preview, Quick Look)
/// happens without holding the database lock; the lock is taken once for a single
/// short transaction that writes the asset rows and the card rows together.
#[tauri::command]
pub fn create_file_card(
    db: DbState<'_>,
    app: tauri::AppHandle,
    input: CreateFileCardCommandInput,
) -> Result<FileCardDto, WorkspaceError> {
    let asset_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| WorkspaceError::Database(e.to_string()))?
        .join("assets");

    let id = input.id.clone();
    let file_name = input.file_name.clone();
    let mime_type = input.mime_type.clone();
    let source_path = input.source_path.clone();

    // Stage 1: idempotent replay lookup (brief lock, no I/O).
    let replay = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        asset_service::load_asset(&conn, &id)?
    };

    // Stage 2: copy the bytes and read the preview without holding the lock.
    // A replay (the asset row already exists) stages nothing: that file is
    // already managed and must never be treated as ours to delete.
    let new_asset = match &replay {
        Some(_) => None,
        None => Some(asset_service::stage_file_card_asset(
            &asset_dir,
            &id,
            &file_name,
            &mime_type,
            &source_path,
        )?),
    };
    let asset = match (&replay, &new_asset) {
        (Some(existing), _) => existing.clone(),
        (None, Some(staged)) => staged.asset.clone(),
        (None, None) => unreachable!("staging produces an asset when there is no replay"),
    };

    let preview = if file_name.to_ascii_lowercase().ends_with(".zip") {
        "(zip archive)".to_string()
    } else if matches!(
        file_name
            .rsplit('.')
            .next()
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some(
            "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ppt"
                | "pptx"
                | "pdf"
                | "pages"
                | "numbers"
                | "key"
                | "odt"
                | "ods"
                | "odp"
        )
    ) {
        "(office document)".to_string()
    } else {
        asset_service::read_text_preview(&asset_dir, &asset, 8 * 1024)
    };

    // Stage 2b: Quick Look thumbnail, also outside the lock (it is a subprocess).
    let thumbnail = if new_asset.is_some()
        && matches!(
            file_name
                .rsplit('.')
                .next()
                .map(|e| e.to_ascii_lowercase())
                .as_deref(),
            Some(
                "pdf"
                    | "doc"
                    | "docx"
                    | "xls"
                    | "xlsx"
                    | "ppt"
                    | "pptx"
                    | "pages"
                    | "numbers"
                    | "key"
            )
        ) {
        asset_service::stage_thumbnail(&asset_dir, &source_path)?
    } else {
        None
    };

    // Stage 3: one short transaction for the asset rows and the card rows. A
    // failure rolls the rows back and removes only the files staged above.
    let model = CreateFileCardInput {
        id: id.clone(),
        board_id: input.board_id.clone(),
        frame: input.frame,
        z_index: input.z_index,
        source_path: source_path.clone(),
        mime_type: mime_type.clone(),
        file_name: file_name.clone(),
    };
    {
        let mut conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        asset_service::commit_file_card(
            &mut conn,
            &model,
            &asset,
            new_asset.as_ref(),
            &preview,
            thumbnail.as_ref(),
        )?;
    }

    let preview_asset = thumbnail.as_ref().map(|staged| staged.asset.clone());

    Ok(FileCardDto {
        id: input.id,
        board_id: input.board_id,
        frame: input.frame,
        z_index: input.z_index,
        revision: 1,
        asset,
        preview_text: preview,
        preview_asset,
    })
}

/// Opens a File Card's stored copy in the default external app.
#[tauri::command]
pub fn open_file_card(
    db: DbState<'_>,
    app: tauri::AppHandle,
    card_id: String,
) -> Result<(), WorkspaceError> {
    let asset_path = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        let asset_file = workspace_repository::load_file_card_asset(&conn, &card_id)?;
        let asset_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| WorkspaceError::Database(e.to_string()))?
            .join("assets");
        asset_service::asset_abs_path(&asset_dir, &asset_file)
    };
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&asset_path)
        .status()
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let _ = asset_path;
    Ok(())
}

/// Reveals the File Card's original source file in Finder (selected). Falls back
/// to the managed copy when the source path is unknown.
#[tauri::command]
pub fn reveal_file_card(
    db: DbState<'_>,
    app: tauri::AppHandle,
    card_id: String,
) -> Result<(), WorkspaceError> {
    let (source, asset_file) = {
        let conn = db
            .lock()
            .map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
        let source = workspace_repository::load_file_card_source_path(&conn, &card_id)?;
        let asset_file = workspace_repository::load_file_card_asset(&conn, &card_id)?;
        (source, asset_file)
    };
    let target = if !source.is_empty() && std::path::Path::new(&source).exists() {
        source
    } else {
        let asset_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| WorkspaceError::Database(e.to_string()))?
            .join("assets");
        asset_service::asset_abs_path(&asset_dir, &asset_file)
            .to_string_lossy()
            .into_owned()
    };
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(&target)
        .status()
        .map_err(|e| WorkspaceError::Database(e.to_string()))?;
    #[cfg(not(target_os = "macos"))]
    let _ = target;
    Ok(())
}
