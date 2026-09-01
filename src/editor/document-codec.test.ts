import { describe, expect, it } from "vitest";
import { documentToPlainText, plainTextToDocument } from "./document-codec";

describe("document codec", () => {
  it("round-trips plain text", () => {
    const doc = plainTextToDocument("hello world");
    expect(documentToPlainText(doc)).toBe("hello world");
  });

  it("encodes empty text as an empty paragraph", () => {
    const doc = plainTextToDocument("");
    expect(doc).toEqual({ type: "doc", content: [{ type: "paragraph", content: [] }] });
    expect(documentToPlainText(doc)).toBe("");
  });

  it("handles multiline text across paragraphs", () => {
    const doc = plainTextToDocument("a\nb");
    expect(documentToPlainText(doc)).toBe("a\nb");
  });

  it("returns empty string for malformed input", () => {
    expect(documentToPlainText(null)).toBe("");
    expect(documentToPlainText(42)).toBe("");
  });
});
