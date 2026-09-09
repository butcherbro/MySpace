//! Filesystem alias resolution is deliberately behind this narrow boundary.
//! SQLite holds opaque locator bytes; a path hint is display-only metadata.

use crate::domain::models::{FolderEntryDto, FolderPreviewDto, FolderPreviewStatus};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocatorError {
    Missing,
    PermissionLost,
    Io,
}

/// RAII guard that stops a macOS security-scoped access when dropped.
pub struct SecurityScopeGuard {
    #[cfg(target_os = "macos")]
    url: objc2::rc::Retained<objc2_foundation::NSURL>,
}
#[cfg(target_os = "macos")]
impl Drop for SecurityScopeGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = self.url.stopAccessingSecurityScopedResource();
        }
    }
}
#[cfg(not(target_os = "macos"))]
pub struct SecurityScopeGuard;

/// A resolved folder plus an active security scope that must live as long as the
/// returned path is read. Callers hold this value until done; dropping it stops
/// the scope.
pub struct ResolvedFolder {
    pub path: PathBuf,
    pub refreshed_locator: Option<Vec<u8>>,
    pub _scope: Option<SecurityScopeGuard>,
}

/// Platform-specific bookmark implementation. Tests inject a fake locator so
/// directory semantics remain cross-platform and do not require Objective-C.
pub trait FolderLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError>;
    /// The optional bytes replace stale bookmark data transactionally by caller.
    fn resolve(&self, locator: &[u8]) -> Result<ResolvedFolder, LocatorError>;
}

pub fn list_preview(
    locator: &dyn FolderLocator,
    locator_blob: &[u8],
    path_hint: &str,
    display_name: &str,
    limit: usize,
) -> FolderPreviewDto {
    list_preview_with_refresh(locator, locator_blob, path_hint, display_name, limit).0
}

/// Returns a replacement locator only after successful resolution; callers persist it
/// with refreshed display metadata in the same SQLite transaction.
pub fn list_preview_with_refresh(
    locator: &dyn FolderLocator,
    locator_blob: &[u8],
    path_hint: &str,
    display_name: &str,
    limit: usize,
) -> (FolderPreviewDto, Option<Vec<u8>>, Option<PathBuf>) {
    let base = || FolderPreviewDto {
        status: FolderPreviewStatus::IoError,
        entries: vec![],
        has_more: false,
        display_name: display_name.into(),
        path_hint: path_hint.into(),
    };
    let resolved = match locator.resolve(locator_blob) {
        Ok(value) => value,
        Err(LocatorError::Missing) => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::Missing,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(LocatorError::PermissionLost) => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::PermissionLost,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(LocatorError::Io) => return (base(), None, None),
    };
    let path = resolved.path;
    let read = match std::fs::read_dir(&path) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::Missing,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return (
                FolderPreviewDto {
                    status: FolderPreviewStatus::PermissionLost,
                    ..base()
                },
                None,
                None,
            )
        }
        Err(_) => return (base(), None, None),
    };
    let mut entries = Vec::new();
    for item in read.take(201) {
        let Ok(item) = item else {
            return (base(), None, None);
        };
        let Ok(metadata) = item.metadata() else {
            return (base(), None, None);
        };
        let is_dir = metadata.is_dir();
        entries.push(FolderEntryDto {
            name: item.file_name().to_string_lossy().into_owned(),
            kind: if is_dir { "folder" } else { "file" }.into(),
            size_bytes: (!is_dir).then_some(metadata.len() as i64),
            child_count: None,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != "folder", a.name.to_lowercase())
            .cmp(&(b.kind != "folder", b.name.to_lowercase()))
    });
    let has_more = entries.len() > limit || entries.len() == 201;
    entries.truncate(limit.min(50));
    // Reflect the freshly resolved identity, not the pre-refresh values.
    let refreshed_display = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(display_name);
    let refreshed_hint = path.to_string_lossy().into_owned();
    (
        FolderPreviewDto {
            status: if entries.is_empty() {
                FolderPreviewStatus::Empty
            } else {
                FolderPreviewStatus::Ready
            },
            entries,
            has_more,
            display_name: refreshed_display.to_owned(),
            path_hint: refreshed_hint,
        },
        resolved.refreshed_locator,
        Some(path),
    )
}

#[cfg(target_os = "macos")]
pub struct MacosBookmarkLocator;
#[cfg(target_os = "macos")]
impl Default for MacosBookmarkLocator {
    fn default() -> Self {
        Self
    }
}
#[cfg(target_os = "macos")]
impl FolderLocator for MacosBookmarkLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError> {
        use objc2_foundation::{NSString, NSURLBookmarkCreationOptions, NSURL};
        let value = path.to_str().ok_or(LocatorError::Io)?;
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(value), true);
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope
                | NSURLBookmarkCreationOptions::SecurityScopeAllowOnlyReadAccess,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|_| LocatorError::Io)
    }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        use objc2::runtime::Bool;
        use objc2_foundation::{
            NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
        };
        let data = NSData::with_bytes(bytes);
        let mut stale = Bool::default();
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .map_err(|_| LocatorError::Missing)?;
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err(LocatorError::PermissionLost);
        }
        let path = url.path().ok_or(LocatorError::Missing)?.to_string();
        let refreshed_locator = if stale.as_bool() {
            Some(
                url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                    NSURLBookmarkCreationOptions::WithSecurityScope
                        | NSURLBookmarkCreationOptions::SecurityScopeAllowOnlyReadAccess,
                    None,
                    None,
                )
                .map_err(|_| LocatorError::Io)?
                .to_vec(),
            )
        } else {
            None
        };
        let scope = SecurityScopeGuard { url };
        Ok(ResolvedFolder {
            path: PathBuf::from(path),
            refreshed_locator,
            _scope: Some(scope),
        })
    }
}

#[cfg(not(target_os = "macos"))]
pub struct UnsupportedPlatformLocator;
#[cfg(not(target_os = "macos"))]
impl Default for UnsupportedPlatformLocator {
    fn default() -> Self {
        Self
    }
}
#[cfg(not(target_os = "macos"))]
impl FolderLocator for UnsupportedPlatformLocator {
    fn create(&self, _: &Path) -> Result<Vec<u8>, LocatorError> {
        Err(LocatorError::Io)
    }
    fn resolve(&self, _: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        Err(LocatorError::Io)
    }
}

/// Classifies a dropped native path into a drop kind plus display metadata.
/// `folder` -> shortcut, `image` -> existing image-card path, else unsupported.
pub fn classify_drop(path: &Path) -> (String, Option<String>, Option<String>) {
    let file_name = path.file_name().and_then(|v| v.to_str()).map(str::to_owned);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_owned);
    let kind = if path.is_dir() {
        "folder"
    } else if matches!(
        ext.as_deref().map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg")
    ) {
        "image"
    } else {
        "unsupported"
    };
    let mime = if kind == "image" {
        mime_for_ext(ext.as_deref())
    } else {
        None
    };
    (kind.to_string(), file_name, mime)
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
