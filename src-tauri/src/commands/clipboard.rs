//! Clipboard helpers for the macOS MySpace app.
//!
//! The UI's "Copy MySpace Link" and "Copy File Path" actions write plain text to
//! the system pasteboard. We drive `NSPasteboard` directly (via `objc2-app-kit`,
//! already a transitive dependency of Tauri on macOS) rather than the web
//! Clipboard API, because WKWebView's `navigator.clipboard` requires a
//! permissions/secure-context dance that is flaky outside a user gesture.

/// Copies a plain-text string to the system clipboard.
#[cfg(target_os = "macos")]
pub fn copy_text(text: &str) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let string = NSString::from_str(text);
    let written = unsafe { pasteboard.setString_forType(&string, NSPasteboardTypeString) };
    if written {
        Ok(())
    } else {
        Err("clipboard write was rejected by the pasteboard".to_string())
    }
}

/// Copies a plain-text string to the system clipboard.
#[cfg(not(target_os = "macos"))]
pub fn copy_text(_text: &str) -> Result<(), String> {
    Err("clipboard copy is only implemented on macOS".to_string())
}

/// Tauri command wrapper for `copy_text`.
#[tauri::command]
pub fn copy_text_command(text: String) -> Result<(), String> {
    copy_text(&text)
}

/// Copies one or more image files to the system pasteboard as file references,
/// so they can be pasted into Finder (as copies), chat/agents, or any app that
/// accepts dragged/copied file URLs.
#[cfg(target_os = "macos")]
pub fn copy_image_files(paths: &[std::path::PathBuf]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let pasteboard: Retained<NSPasteboard> = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();

    let urls: Vec<Retained<NSURL>> = paths
        .iter()
        .map(|p| {
            let s = NSString::from_str(&p.to_string_lossy());
            NSURL::fileURLWithPath(&s)
        })
        .collect();

    // `writeObjects` expects `NSArray<ProtocolObject<dyn NSPasteboardWriting>>`.
    // NSURL conforms to NSPasteboardWriting; wrap each retained URL as a
    // protocol object and collect into an array.
    let mut objects: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
    for url in urls.into_iter() {
        objects.push(ProtocolObject::from_retained(url));
    }
    let array = NSArray::from_retained_slice(&objects);

    let ok = pasteboard.writeObjects(&array);
    if ok {
        Ok(())
    } else {
        Err("clipboard write was rejected by the pasteboard".to_string())
    }
}

/// Non-macOS stub.
#[cfg(not(target_os = "macos"))]
pub fn copy_image_files(_paths: &[std::path::PathBuf]) -> Result<(), String> {
    Err("clipboard copy is only implemented on macOS".to_string())
}
