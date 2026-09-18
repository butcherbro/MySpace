// HTML clipboard content -> ProseMirror-shaped document, for pasting formatted
// text (Telegram/browser/other apps) onto the empty canvas — no editor is open
// there, so there is no ProseMirror instance to hand the paste event to the way
// an open note gets one for free.
//
// Uses the SAME extension set as the real editor (`createEditorExtensions`), so
// the result can only contain what the editor's own schema allows: unknown tags
// are dropped, and known tags (b/strong, i/em, s, p, ul/ol/li, blockquote, br)
// map to the same marks/nodes typing them in the editor would produce. Inline
// `style`/`color`/`font-family` never survive because none of our marks declare
// attributes for them — Bold/Italic/Strike carry no attrs at all, so parsing
// `<span style="color:red">` yields (at most) the bold/italic recognized from a
// `font-weight`/`font-style` style value, never the color or font itself.

import { generateJSON } from "@tiptap/core";
import { createEditorExtensions } from "./editor-extensions";
import { normalizeDocument, plainTextToDocument } from "./document-codec";

/**
 * Converts a clipboard HTML fragment into a document the editor's own schema
 * accepts. Falls back to a plain-text document if `html` fails to parse (should
 * not normally happen — `generateJSON` is lenient — but a paste must never
 * throw and lose the clipboard content).
 */
export function htmlToDocument(html: string, plainTextFallback: string): unknown {
  try {
    const json = generateJSON(html, createEditorExtensions());
    return normalizeDocument(json);
  } catch {
    return plainTextToDocument(plainTextFallback);
  }
}
