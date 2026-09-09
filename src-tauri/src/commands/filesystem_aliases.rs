//! Tauri boundary for folder shortcuts. Resolved paths never cross into JS.
use std::{path::{Path, PathBuf}, sync::Mutex};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::{domain::{errors::WorkspaceError, filesystem_alias_service::{self, FolderLocator, LocatorError}, models::{CreateFilesystemAliasInput, FilesystemAliasDto, FolderPreviewDto}}, repositories::workspace_repository};

pub type DbState<'a> = State<'a, Mutex<Connection>>;
struct LocalLocator;
impl FolderLocator for LocalLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError> { Ok(path.as_os_str().as_encoded_bytes().to_vec()) }
    fn resolve(&self, bytes: &[u8]) -> Result<(PathBuf, Option<Vec<u8>>), LocatorError> {
        let path = PathBuf::from(String::from_utf8_lossy(bytes).to_string());
        if path.exists() { Ok((path, None)) } else { Err(LocatorError::Missing) }
    }
}
#[derive(Debug, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CreateFolderAliasCommandInput { pub id: String, pub board_id: String, pub frame: crate::domain::models::Frame, pub z_index: i64, pub source_path: String }
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub struct ClassifiedDrop { pub path: String, pub kind: String, pub file_name: Option<String>, pub mime_type: Option<String> }

#[tauri::command]
pub fn create_folder_alias(db: DbState<'_>, input: CreateFolderAliasCommandInput) -> Result<FilesystemAliasDto, WorkspaceError> {
    let path = PathBuf::from(&input.source_path);
    if !path.is_dir() { return Err(WorkspaceError::ConstraintViolation("folder alias target must be an existing directory".into())); }
    let display_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("Folder").to_string();
    let locator = LocalLocator;
    let locator_blob = locator.create(&path).map_err(|_| WorkspaceError::ConstraintViolation("could not create folder locator".into()))?;
    let model = CreateFilesystemAliasInput { id: input.id, board_id: input.board_id, frame: input.frame, z_index: input.z_index, target_kind: "folder".into(), locator_blob, path_hint: path.to_string_lossy().into_owned(), display_name };
    let mut conn = db.lock().map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    workspace_repository::create_filesystem_alias(&mut conn, &model)?;
    Ok(FilesystemAliasDto { id: model.id, board_id: model.board_id, frame: model.frame, z_index: model.z_index, revision: 1, target_kind: model.target_kind, path_hint: model.path_hint, display_name: model.display_name })
}
#[tauri::command]
pub fn list_folder_preview(db: DbState<'_>, card_id: String, limit: usize) -> Result<FolderPreviewDto, WorkspaceError> {
    let conn = db.lock().map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?;
    let (blob, hint, name) = workspace_repository::load_filesystem_alias_locator(&conn, &card_id)?;
    Ok(filesystem_alias_service::list_preview(&LocalLocator, &blob, &hint, &name, limit))
}
#[tauri::command]
pub fn classify_drop_paths(paths: Vec<String>) -> Vec<ClassifiedDrop> { paths.into_iter().map(|path| { let file_name = Path::new(&path).file_name().and_then(|v| v.to_str()).map(str::to_owned); let kind = if Path::new(&path).is_dir() { "folder" } else if matches!(Path::new(&path).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("png"|"jpg"|"jpeg"|"gif"|"webp"|"heic")) { "image" } else { "unsupported" }; ClassifiedDrop { path, kind: kind.into(), file_name, mime_type: None } }).collect() }
#[tauri::command]
pub fn open_folder_in_finder(db: DbState<'_>, card_id: String) -> Result<(), WorkspaceError> { let conn = db.lock().map_err(|_| WorkspaceError::Database("db lock poisoned".into()))?; let (blob, _, _) = workspace_repository::load_filesystem_alias_locator(&conn, &card_id)?; let (path, _) = LocalLocator.resolve(&blob).map_err(|_| WorkspaceError::NotFound(card_id))?; #[cfg(target_os = "macos")] std::process::Command::new("open").arg(&path).status().map_err(|e| WorkspaceError::Database(e.to_string()))?; #[cfg(not(target_os = "macos"))] let _ = path; Ok(()) }
