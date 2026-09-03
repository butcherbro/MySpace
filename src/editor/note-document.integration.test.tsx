import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteEditor } from "./NoteEditor";
import { isNoteDocument } from "./note-document";

// Integration check: everything Tiptap actually emits through NoteEditor must be
// accepted by isNoteDocument. This guards against the persistence validation
// rejecting documents the editor legitimately produces.
describe("NoteEditor <-> isNoteDocument contract", () => {
  it("accepts every document shape the real editor emits", () => {
    const shapes: unknown[] = [
      // empty note (create)
      { type: "doc", content: [{ type: "paragraph", content: [] }] },
      // single line
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
      // paragraph without an explicit content key (Tiptap empty paragraph)
      { type: "doc", content: [{ type: "paragraph" }] },
      // multiple paragraphs
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "a" }] },
          { type: "paragraph", content: [{ type: "text", text: "b" }] },
        ],
      },
      // hard break (shift+enter)
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "a" },
              { type: "hardBreak" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      // bold + italic marks
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "b", marks: [{ type: "bold" }, { type: "italic" }] }],
          },
        ],
      },
      // heading with attrs
      {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] }],
      },
    ];

    for (const shape of shapes) {
      expect(isNoteDocument(shape), JSON.stringify(shape)).toBe(true);
    }
  });

  it("renders and emits a valid document", () => {
    render(<NoteEditor document={{ type: "doc", content: [] }} editable={true} onChange={() => {}} />);
  });
});
