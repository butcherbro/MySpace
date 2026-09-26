//! Document -> plain-text codec for ProseMirror/Tiptap-shaped JSON (P1.5).
//!
//! The derived `plain_text` / `caption_plain_text` / `description_plain_text`
//! columns are computed here and nowhere else, so every writer (UI, MCP,
//! enrichment, a replayed sync journal) stores identical text for the same
//! document. This is a faithful port of `documentToPlainText` in
//! `src/editor/document-codec.ts`; the TypeScript copy only serves instant
//! local UI. Both are pinned by `src-tauri/tests/fixtures/plain_text_cases.json`.

use serde_json::Value;

/// Decodes a ProseMirror-shaped document into plain text, one line per
/// top-level block (empty blocks dropped). Marks are ignored. Anything that is
/// not an object with `type == "doc"` yields `""`.
pub fn document_to_plain_text(doc: &Value) -> String {
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return String::new();
    }
    children(doc)
        .iter()
        .map(block_to_text)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Wraps plain text into the minimal document the editor and enrichment use:
/// one paragraph, with no text node when `text` is empty.
pub fn plain_text_to_document(text: &str) -> Value {
    if text.is_empty() {
        serde_json::json!({"type":"doc","content":[{"type":"paragraph"}]})
    } else {
        serde_json::json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
    }
}

fn node_type(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

/// `node.content ?? []`: a missing or non-array `content` has no children.
fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Renders a single top-level block to an inline string (no trailing newline).
fn block_to_text(block: &Value) -> String {
    match node_type(block) {
        Some("bulletList") | Some("orderedList") => children(block)
            .iter()
            .filter(|n| node_type(n) == Some("listItem"))
            .map(|item| {
                let joined = children(item)
                    .iter()
                    .map(inline_or_block)
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("• {}", js_trim(&joined))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some("horizontalRule") => "---".to_string(),
        // paragraph, heading, blockquote, codeBlock and unknown blocks.
        _ => inline_text(block),
    }
}

/// Recursively concatenates text from a node (handles nested lists/blocks).
fn inline_or_block(node: &Value) -> String {
    match node_type(node) {
        Some("text") => node
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        Some("hardBreak") => "\n".to_string(),
        Some("bulletList") | Some("orderedList") => block_to_text(node),
        _ => inline_text(node),
    }
}

/// Concatenates `text` and `hardBreak` descendants into one string.
fn inline_text(node: &Value) -> String {
    children(node).iter().map(inline_or_block).collect()
}

/// `String.prototype.trim`: ECMAScript WhiteSpace + LineTerminator. Differs
/// from Rust's `char::is_whitespace` in two code points (JS trims U+FEFF,
/// Rust trims U+0085), so it is spelled out to keep both codecs identical.
fn js_trim(s: &str) -> &str {
    fn is_js_whitespace(c: char) -> bool {
        c == '\u{FEFF}' || (c != '\u{0085}' && c.is_whitespace())
    }
    s.trim_matches(is_js_whitespace)
}
