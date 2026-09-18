//! Filesystem alias resolution is deliberately behind this narrow boundary.
//! SQLite holds opaque locator bytes; a path hint is display-only metadata.

use crate::domain::models::{FolderEntryDto, FolderPreviewDto, FolderPreviewStatus};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocatorError {
    Missing,
    PermissionLost,
    /// A platform-level failure, carrying a short system diagnostic (NSError
    /// domain/code/description). Keeping the reason stops a broken locator from
    /// collapsing into an opaque "could not create folder locator" and makes a
    /// future regression diagnosable from the error text alone.
    Io(String),
}

impl std::fmt::Display for LocatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocatorError::Missing => write!(f, "bookmark not found"),
            LocatorError::PermissionLost => write!(f, "permission lost"),
            LocatorError::Io(message) => write!(f, "{message}"),
        }
    }
}

/// A folder resolved from a stored bookmark. The app is not sandboxed, so the
/// bookmark is a plain one and there is no security scope to hold open.
pub struct ResolvedFolder {
    pub path: PathBuf,
    pub refreshed_locator: Option<Vec<u8>>,
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
        Err(LocatorError::Io(_)) => return (base(), None, None),
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

/// Bookmark creation options for folder locators.
///
/// Kept as a named constant so a regression guard can assert it stays a *plain*
/// bookmark: this app is not sandboxed, and requesting a security scope fails
/// outside App Sandbox (see ADR-0006).
#[cfg(target_os = "macos")]
pub const FOLDER_BOOKMARK_CREATION_OPTIONS: objc2_foundation::NSURLBookmarkCreationOptions =
    objc2_foundation::NSURLBookmarkCreationOptions::empty();
#[cfg(target_os = "macos")]
impl Default for MacosBookmarkLocator {
    fn default() -> Self {
        Self
    }
}
/// Short, stable description of a Foundation error for diagnostics.
#[cfg(target_os = "macos")]
fn describe_ns_error(error: &objc2_foundation::NSError) -> String {
    format!(
        "{} {}: {}",
        error.domain(),
        error.code(),
        error.localizedDescription()
    )
}

/// True when a Foundation error means the bookmarked item no longer exists. Such
/// a failure keeps the user-facing `Missing` status; anything else is surfaced as
/// an IO error carrying the real reason instead of being swallowed.
#[cfg(target_os = "macos")]
fn is_missing_target_error(error: &objc2_foundation::NSError) -> bool {
    /// `NSFileNoSuchFileError`.
    const NO_SUCH_FILE: isize = 4;
    /// `NSFileReadNoSuchFileError`.
    const READ_NO_SUCH_FILE: isize = 260;
    let code = error.code();
    (code == NO_SUCH_FILE || code == READ_NO_SUCH_FILE)
        && error.domain().to_string() == "NSCocoaErrorDomain"
}

#[cfg(target_os = "macos")]
impl FolderLocator for MacosBookmarkLocator {
    fn create(&self, path: &Path) -> Result<Vec<u8>, LocatorError> {
        use objc2_foundation::{NSString, NSURL};
        let value = path
            .to_str()
            .ok_or_else(|| LocatorError::Io("path is not valid UTF-8".into()))?;
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(value), true);
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            FOLDER_BOOKMARK_CREATION_OPTIONS,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|error| LocatorError::Io(describe_ns_error(&error)))
    }
    fn resolve(&self, bytes: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        use objc2::runtime::Bool;
        use objc2_foundation::{NSData, NSURLBookmarkResolutionOptions, NSURL};
        let data = NSData::with_bytes(bytes);
        let mut stale = Bool::default();
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithoutUI,
                None,
                &mut stale,
            )
        }
        .map_err(|error| {
            if is_missing_target_error(&error) {
                LocatorError::Missing
            } else {
                LocatorError::Io(describe_ns_error(&error))
            }
        })?;
        let path = url.path().ok_or(LocatorError::Missing)?.to_string();
        let refreshed_locator = if stale.as_bool() {
            Some(
                url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                    FOLDER_BOOKMARK_CREATION_OPTIONS,
                    None,
                    None,
                )
                .map_err(|error| LocatorError::Io(describe_ns_error(&error)))?
                .to_vec(),
            )
        } else {
            None
        };
        Ok(ResolvedFolder {
            path: PathBuf::from(path),
            refreshed_locator,
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
        Err(LocatorError::Io(
            "folder shortcuts require a macOS build".into(),
        ))
    }
    fn resolve(&self, _: &[u8]) -> Result<ResolvedFolder, LocatorError> {
        Err(LocatorError::Io(
            "folder shortcuts require a macOS build".into(),
        ))
    }
}

/// Classifies a dropped native path into a drop kind plus display metadata.
/// `folder` -> shortcut, `image` -> existing image-card path, else unsupported.
pub fn classify_drop(path: &Path) -> (String, Option<String>, Option<String>) {
    let file_name = path.file_name().and_then(|v| v.to_str()).map(str::to_owned);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_owned);
    let ext_lower = ext.as_deref().map(|e| e.to_ascii_lowercase());
    let kind = if path.is_dir() {
        "folder"
    } else if matches!(
        ext_lower.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "svg")
    ) {
        "image"
    } else if matches!(
        ext_lower.as_deref(),
        Some("txt" | "md" | "markdown" | "json" | "csv" | "rtf" | "log" | "html" | "htm")
    ) {
        "text_file"
    } else if ext_lower.as_deref() == Some("zip") {
        "archive"
    } else if matches!(
        ext_lower.as_deref(),
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
                | "odp",
        )
    ) {
        "office_file"
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

/// Classifies a single pasted path (todo.md №23, Cmd+V on the empty canvas):
/// `~`/`~/...` is expanded against `home_dir` first (so it resolves the same
/// way Finder/the shell would), then the expanded path is checked against the
/// filesystem. Returns `("folder" | "file" | "missing", expanded_path)` — a
/// missing path is the signal for the caller to fall back to a plain-text
/// note paste instead of creating a shortcut/file card.
pub fn classify_path(raw: &str, home_dir: Option<&Path>) -> (String, PathBuf) {
    let expanded = expand_home(raw, home_dir);
    let path = PathBuf::from(&expanded);
    let kind = if path.is_dir() {
        "folder"
    } else if path.is_file() {
        "file"
    } else {
        "missing"
    };
    (kind.to_string(), path)
}

fn expand_home(raw: &str, home_dir: Option<&Path>) -> String {
    let Some(home) = home_dir else {
        return raw.to_string();
    };
    if raw == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return home.join(rest).to_string_lossy().into_owned();
    }
    raw.to_string()
}
