import { describe, expect, it } from "vitest";
import { conflictCopyDocument, conflictCopyFrame } from "./note-conflict-copy";

describe("note conflict copy", () => {
  it("prepends a bold Conflict copy paragraph to the document", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "mine" }] }] };
    expect(conflictCopyDocument(doc)).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Conflict copy", marks: [{ type: "bold" }] }] },
        { type: "paragraph", content: [{ type: "text", text: "mine" }] },
      ],
    });
    expect(doc.content).toHaveLength(1);
  });

  it("does not add a second heading to a conflict copy's own text", () => {
    const copy = conflictCopyDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "mine" }] }] });
    expect(conflictCopyDocument(copy)).toEqual(copy);
    // As the editor hands it back: marks before text.
    const edited = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "Conflict copy" }] },
        { type: "paragraph", content: [{ type: "text", text: "mine and more" }] },
      ],
    };
    expect(conflictCopyDocument(edited)).toBe(edited);
  });

  it("falls back to plain text for a document without content", () => {
    expect(conflictCopyDocument(null)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Conflict copy\n" }] }],
    });
  });

  it("places the copy right of the original, 24 px apart, same size", () => {
    expect(conflictCopyFrame({ x: 10, y: 20, width: 240, height: 120 })).toEqual({ x: 274, y: 20, width: 240, height: 120 });
  });
});
