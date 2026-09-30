import { documentToPlainText, plainTextToDocument } from "../editor/document-codec";
import type { Frame } from "../services/workspace-gateway";
import { sameDocument } from "../commands/card-commands";

// A note save refused because another writer changed the text keeps the refused
// text in a new note, built the way device sync builds its conflict copies
// (src-tauri/src/sync/replay.rs: `conflict_document`, `create_conflict_copy`).

/** Heading of a conflict-copy note (`CONFLICT_COPY_TITLE` in replay.rs). */
export const CONFLICT_COPY_TITLE = "Conflict copy";

/**
 * `document` with a bold "Conflict copy" paragraph prepended, unless it already
 * starts with one (the text of a conflict copy that itself met a conflict).
 */
export function conflictCopyDocument(document: unknown): unknown {
  const heading = {
    type: "paragraph",
    content: [{ type: "text", text: CONFLICT_COPY_TITLE, marks: [{ type: "bold" }] }],
  };
  const doc = document as { content?: unknown } | null;
  if (typeof doc === "object" && doc !== null && Array.isArray(doc.content)) {
    if (sameDocument(doc.content[0], heading)) return doc;
    return { ...doc, content: [heading, ...(doc.content as unknown[])] };
  }
  return plainTextToDocument(`${CONFLICT_COPY_TITLE}\n${documentToPlainText(document)}`);
}

/** The copy sits right of the original, same size (replay.rs `create_conflict_copy`). */
export function conflictCopyFrame(original: Frame): Frame {
  return { ...original, x: original.x + original.width + 24 };
}
