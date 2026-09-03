import { describe, expect, it } from "vitest";
import { documentToPlainText, plainTextToDocument } from "./document-codec";

describe("document codec", () => {
  it("round-trips plain text", () => {
    const doc = plainTextToDocument("hello world");
    expect(documentToPlainText(doc)).toBe("hello world");
  });

  it("encodes empty text as an empty paragraph", () => {
    const doc = plainTextToDocument("");
    expect(documentToPlainText(doc)).toBe("");
  });

  it("extracts text from headings", () => {
    const doc = {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] }],
    };
    expect(documentToPlainText(doc)).toBe("Title");
  });

  it("extracts text with marks (bold/italic) as plain text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " plain" },
          ],
        },
      ],
    };
    expect(documentToPlainText(doc)).toBe("bold plain");
  });

  it("renders bullet lists with markers", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
      ],
    };
    expect(documentToPlainText(doc)).toBe("• a\n• b");
  });

  it("joins multiple blocks with newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    };
    expect(documentToPlainText(doc)).toBe("one\ntwo");
  });

  it("returns empty for malformed input", () => {
    expect(documentToPlainText(null)).toBe("");
    expect(documentToPlainText(42)).toBe("");
    expect(documentToPlainText({ type: "not-doc" })).toBe("");
  });
});
