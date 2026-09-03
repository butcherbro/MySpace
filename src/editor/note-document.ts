// The application-owned document model for note content.
//
// Tiptap's `JSONContent` is intentionally NOT exported outside `NoteEditor`.
// Instead, the app speaks this narrow `NoteDocument` shape (a ProseMirror-style
// doc restricted to the V1 schema), validated at the persistence boundary so a
// malformed document (e.g. from a future schema, a bad paste, or hand-edited
// data) can never silently round-trip through SQLite.

/** A single node in the V1 document schema (loosely typed for forward-compat). */
export interface NoteNode {
  type: string;
  text?: string;
  content?: NoteNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

/** The root document: a `doc` node whose children are V1 block nodes. */
export interface NoteDocument {
  type: "doc";
  content: NoteNode[];
}

/** Inline node types allowed in V1. */
const ALLOWED_INLINE_TYPES = new Set(["text", "hardBreak"]);

/** Mark types allowed in V1 (bold/italic only). */
const ALLOWED_MARK_TYPES = new Set(["bold", "italic"]);

function isNode(value: unknown): value is NoteNode {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>).type === "string";
}

function validMarks(node: NoteNode): boolean {
  if (!node.marks) return true;
  return node.marks.every((m) => ALLOWED_MARK_TYPES.has(m.type));
}

/**
 * Validates a node that is allowed to sit inline (text/hardBreak) or contain
 * inline children (paragraph/heading/blockquote).
 */
function validInlineContainer(node: NoteNode): boolean {
  if (!validMarks(node)) return false;
  return (node.content ?? []).every((child) => {
    if (!validMarks(child)) return false;
    return ALLOWED_INLINE_TYPES.has(child.type);
  });
}

/**
 * Validates a `listItem`, which wraps one or more *block* children (usually a
 * single `paragraph`) rather than inline nodes directly.
 */
function validListItem(node: NoteNode): boolean {
  return (node.content ?? []).every((child) => {
    if (!isNode(child)) return false;
    switch (child.type) {
      case "paragraph":
      case "heading":
      case "blockquote":
        return validInlineContainer(child);
      default:
        return false;
    }
  });
}

/**
 * Validates an unknown value as a `NoteDocument`. Returns `true` only when the
 * document conforms to the V1 schema. Anything else is rejected rather than
 * coerced.
 */
export function isNoteDocument(value: unknown): value is NoteDocument {
  if (!isNode(value)) return false;
  if (value.type !== "doc" || !Array.isArray(value.content)) return false;

  return value.content.every((block) => {
    if (!isNode(block)) return false;
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "blockquote":
        return validInlineContainer(block);

      case "bulletList":
      case "orderedList":
        // A list's children must be listItems.
        return (block.content ?? []).every(
          (item) => item.type === "listItem" && validListItem(item),
        );

      default:
        return false;
    }
  });
}
