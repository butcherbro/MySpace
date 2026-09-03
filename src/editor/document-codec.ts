// Document <-> plain-text codec for ProseMirror/Tiptap-shaped JSON.
//
// `document_json` is authoritative (plan Section E). This codec extracts plain
// text from a full ProseMirror document (headings, lists, blockquotes, code
// blocks, marks) so `plain_text` stays derived and search-friendly even after
// rich-text lands.

/** A ProseMirror-compatible node (loosely typed for forward-compat). */
type PMNode = {
  type?: string;
  text?: string;
  content?: PMNode[];
  attrs?: Record<string, unknown>;
};

/** Encodes plain text into a minimal ProseMirror-shaped document. */
export function plainTextToDocument(text: string): PMNode {
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

/**
 * Decodes a ProseMirror-shaped document into plain text, preserving block
 * boundaries with a newline each. Marks (bold/italic/etc.) are ignored since
 * their text is already in `text`.
 */
export function documentToPlainText(doc: unknown): string {
  if (typeof doc !== "object" || doc === null) return "";
  const root = doc as PMNode;
  if (root.type !== "doc") return "";

  const lines = root.content?.map(blockToText).filter((l) => l !== "") ?? [];
  return lines.join("\n");
}

/**
 * Coerces any persisted value into a shape the editor can render. Handles
 * legacy/malformed rows (empty object, `null`, a bare string, or a non-`doc`
 * root) by falling back to an empty document instead of crashing or rejecting a
 * save.
 */
export function normalizeDocument(value: unknown): PMNode {
  if (typeof value !== "object" || value === null) return emptyDocument();
  const root = value as PMNode;
  if (root.type !== "doc") return emptyDocument();
  return root;
}

function emptyDocument(): PMNode {
  return { type: "doc", content: [{ type: "paragraph", content: [] }] };
}

/** Renders a single top-level block to an inline string (no trailing newline). */
function blockToText(block: PMNode): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
      return inlineText(block);

    case "bulletList":
    case "orderedList": {
      const items = (block.content ?? [])
        .filter((n) => n.type === "listItem")
        .map((item) => {
          // listItem content may nest paragraphs.
          return (item.content ?? []).map(inlineOrBlock).join(" ").trim();
        });
      return items.map((t) => `• ${t}`).join("\n");
    }

    case "horizontalRule":
      return "---";

    default:
      return inlineText(block);
  }
}

/** Recursively concatenates text from a node (handles nested lists/blocks). */
function inlineOrBlock(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "bulletList" || node.type === "orderedList") {
    return blockToText(node);
  }
  return inlineText(node);
}

/** Concatenates `text` and `hardBreak` descendants into one string. */
function inlineText(node: PMNode): string {
  return (node.content ?? []).map(inlineOrBlock).join("");
}
