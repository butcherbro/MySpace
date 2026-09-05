import { describe, expect, it } from "vitest";
import { isNoteDocument } from "./note-document";

describe("isNoteDocument", () => {
  it("accepts the V1 subset (paragraph, heading, lists, blockquote, marks)", () => {
    expect(
      isNoteDocument({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
      }),
    ).toBe(true);

    expect(
      isNoteDocument({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "T" }] },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts the link mark (inline clickable URLs)", () => {
    expect(
      isNoteDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Read ", marks: [{ type: "link", attrs: { href: "https://a.com" } }] },
              { type: "text", text: " here" },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects documents with nodes/marks outside V1", () => {
    // codeBlock is disabled in V1.
    expect(
      isNoteDocument({
        type: "doc",
        content: [{ type: "codeBlock", content: [{ type: "text", text: "x" }] }],
      }),
    ).toBe(false);

    // strike is disabled in V1.
    expect(
      isNoteDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [{ type: "strike" }] }],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(isNoteDocument(null)).toBe(false);
    expect(isNoteDocument(42)).toBe(false);
    expect(isNoteDocument({ type: "not-doc" })).toBe(false);
    expect(isNoteDocument({ type: "doc", content: "nope" })).toBe(false);
  });
});
