// Plain-text <-> document codec.
//
// Until Tiptap lands (Slice 3), notes are plain text. To keep `document_json`
// authoritative (and forward-compatible with Tiptap's ProseMirror schema), we
// store text as a ProseMirror-shaped document rather than leaving it empty and
// relying on a side-channel `plain_text`.

/** A ProseMirror-compatible document (subset used by V1). */
export interface NoteDocument {
  type: "doc";
  content: Array<{
    type: "paragraph";
    content?: Array<{ type: "text"; text: string }>;
  }>;
}

/** Encodes plain text into a ProseMirror-shaped document. */
export function plainTextToDocument(text: string): NoteDocument {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: text.length > 0 ? [{ type: "text", text }] : [],
      },
    ],
  };
}

/** Decodes a ProseMirror-shaped document back into plain text. */
export function documentToPlainText(doc: unknown): string {
  if (typeof doc !== "object" || doc === null) return "";
  const d = doc as { content?: Array<{ content?: Array<{ text?: string }> }> };
  const text: string[] = [];
  for (const block of d.content ?? []) {
    for (const node of block.content ?? []) {
      if (typeof node.text === "string") text.push(node.text);
    }
    text.push("\n");
  }
  // Drop the trailing newline we appended after the last block.
  return text.join("").replace(/\n$/, "");
}
