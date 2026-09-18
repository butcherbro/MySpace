import { describe, expect, it } from "vitest";
import { htmlToDocument } from "./html-to-document";
import { documentToPlainText } from "./document-codec";

// Recursively collects every attrs object in a ProseMirror-shaped document, to
// assert that no node/mark anywhere carries a color/font/style attribute.
function collectAttrs(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (typeof node !== "object" || node === null) return out;
  const n = node as { attrs?: Record<string, unknown>; content?: unknown[]; marks?: { attrs?: Record<string, unknown> }[] };
  if (n.attrs) out.push(n.attrs);
  n.marks?.forEach((m) => {
    if (m.attrs) out.push(m.attrs);
  });
  n.content?.forEach((child) => collectAttrs(child, out));
  return out;
}

describe("htmlToDocument", () => {
  it("keeps bold/italic/strike marks from semantic tags", () => {
    const doc = htmlToDocument(
      "<p>plain <b>bold</b> <em>italic</em> <s>struck</s></p>",
      "plain bold italic struck",
    ) as { content: { content: { marks?: { type: string }[]; text?: string }[] }[] };

    const marks = doc.content[0].content.flatMap((n) => n.marks?.map((m) => m.type) ?? []);
    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
    expect(marks).toContain("strike");
    expect(documentToPlainText(doc)).toBe("plain bold italic struck");
  });

  it("recognizes bold/italic from inline font-weight/font-style styling (Telegram-style copy)", () => {
    const doc = htmlToDocument(
      '<p><span style="font-weight:700">bold via style</span> <span style="font-style:italic">italic via style</span></p>',
      "bold via style italic via style",
    ) as { content: { content: { marks?: { type: string }[] }[] }[] };

    const marks = doc.content[0].content.flatMap((n) => n.marks?.map((m) => m.type) ?? []);
    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
  });

  it("keeps paragraphs, lists and blockquotes as structure", () => {
    const doc = htmlToDocument(
      "<p>intro</p><ul><li>one</li><li>two</li></ul><blockquote><p>quoted</p></blockquote>",
      "intro\none\ntwo\nquoted",
    ) as { content: { type: string }[] };

    const types = doc.content.map((n) => n.type);
    expect(types).toEqual(["paragraph", "bulletList", "blockquote"]);
  });

  it("drops inline color/font styling entirely — no attrs carry style/color/font anywhere", () => {
    const doc = htmlToDocument(
      '<p><span style="color:red;font-family:Arial;background:yellow">colored text</span></p>',
      "colored text",
    );

    const attrs = collectAttrs(doc);
    for (const a of attrs) {
      expect(JSON.stringify(a)).not.toMatch(/color|font|background/i);
    }
    expect(documentToPlainText(doc)).toBe("colored text");
  });

  it("never throws on malformed/empty html (returns a valid, if empty, document)", () => {
    expect(() => htmlToDocument("", "fallback text")).not.toThrow();
    const doc = htmlToDocument("<p><b>unclosed", "fallback text") as { type: string };
    expect(doc.type).toBe("doc");
  });
});
