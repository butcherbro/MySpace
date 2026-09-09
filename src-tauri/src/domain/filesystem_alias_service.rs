//! Filesystem alias resolution is deliberately behind this narrow boundary.
//! SQLite holds opaque locator bytes; a path hint is display-only metadata.

use std::path::{Path, PathBuf};
use crate::domain::models::{FolderEntryDto, FolderPreviewDto, FolderPreviewStatus};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocatorError { Missing, PermissionLost, Io }

/// Platform-specific bookmark implementation. Tests inject a fake locator so
/// directory semantics remain cross-platform and do not require Objective-C.
pub trait FolderLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError>;
    /// The optional bytes replace stale bookmark data transactionally by caller.
    fn resolve(&self, locator: &[u8]) -> Result<(PathBuf, Option<Vec<u8>>), LocatorError>;
}

pub fn list_preview(locator: &dyn FolderLocator, locator_blob: &[u8], path_hint: &str, display_name: &str, limit: usize) -> FolderPreviewDto {
    let base = || FolderPreviewDto { status: FolderPreviewStatus::IoError, entries: vec![], has_more: false, display_name: display_name.into(), path_hint: path_hint.into() };
    let (path, _) = match locator.resolve(locator_blob) {
        Ok(value) => value,
        Err(LocatorError::Missing) => return FolderPreviewDto { status: FolderPreviewStatus::Missing, ..base() },
        Err(LocatorError::PermissionLost) => return FolderPreviewDto { status: FolderPreviewStatus::PermissionLost, ..base() },
        Err(LocatorError::Io) => return base(),
    };
    let read = match std::fs::read_dir(&path) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return FolderPreviewDto { status: FolderPreviewStatus::Missing, ..base() },
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return FolderPreviewDto { status: FolderPreviewStatus::PermissionLost, ..base() },
        Err(_) => return base(),
    };
    let mut entries = Vec::new();
    for item in read.take(201) {
        let Ok(item) = item else { return base() };
        let Ok(metadata) = item.metadata() else { return base() };
        let is_dir = metadata.is_dir();
        entries.push(FolderEntryDto { name: item.file_name().to_string_lossy().into_owned(), kind: if is_dir { "folder" } else { "file" }.into(), size_bytes: (!is_dir).then_some(metadata.len() as i64), child_count: None });
    }
    entries.sort_by(|a, b| (a.kind != "folder", a.name.to_lowercase()).cmp(&(b.kind != "folder", b.name.to_lowercase())));
    let has_more = entries.len() > limit || entries.len() == 201;
    entries.truncate(limit.min(50));
    FolderPreviewDto { status: if entries.is_empty() { FolderPreviewStatus::Empty } else { FolderPreviewStatus::Ready }, entries, has_more, display_name: display_name.into(), path_hint: path_hint.into() }
}
