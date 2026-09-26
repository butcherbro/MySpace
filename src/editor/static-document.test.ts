import { describe, expect, it } from "vitest";
import { decorateStaticHtml, documentToHtml, staticDocumentHtml } from "./static-document";

const doc = (...content: unknown[]) => ({ type: "doc", content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

describe("static document rendering (P1.8)", () => {
  it("serializes marks, headings, lists, links and text colors with the editor's schema", () => {
    const html = documentToHtml(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
        p(
          text("bold", [{ type: "bold" }]),
          text(" "),
          text("gone", [{ type: "strike" }]),
          text(" "),
          text("red", [{ type: "textColor", attrs: { color: "red" } }]),
          text(" "),
          text("site", [{ type: "link", attrs: { href: "https://example.com" } }]),
        ),
        { type: "bulletList", content: [{ type: "listItem", content: [p(text("item"))] }] },
      ),
    )!;
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<s>gone</s>");
    expect(html).toContain('class="text-color--red"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<ul><li><p>item</p></li></ul>");
  });

  it("renders null/empty documents as one empty paragraph and rejects non-documents", () => {
    expect(documentToHtml(null)).toBe("<p></p>");
    expect(documentToHtml({ type: "doc" })).toBe("<p></p>");
    expect(documentToHtml({ type: "paragraph" })).toBeNull();
    expect(documentToHtml(doc({ type: "no_such_node" }))).toBeNull();
    expect(documentToHtml("text")).toBeNull();
  });

  it("gives empty text blocks the trailing break ProseMirror renders, so they keep their height", () => {
    const out = decorateStaticHtml("<p>a</p><p></p><h1></h1>", "");
    expect(out).toBe(
      '<p>a</p><p><br class="ProseMirror-trailingBreak"></p><h1><br class="ProseMirror-trailingBreak"></h1>',
    );
  });

  it("highlights every case-insensitive match per text node, like the editor's decorations", () => {
    const out = decorateStaticHtml("<p>Needle and <strong>needle</strong>, NEEDLE</p>", " needle ");
    expect(out).toBe(
      '<p><span class="search-highlight">Needle</span> and <strong><span class="search-highlight">needle</span></strong>, <span class="search-highlight">NEEDLE</span></p>',
    );
    // Markup in the query is text, never HTML.
    expect(decorateStaticHtml("<p>a&lt;b</p>", "<b")).toBe('<p>a<span class="search-highlight">&lt;b</span></p>');
  });

  it("memoises per document object and query", () => {
    const d = doc(p(text("cached")));
    const first = staticDocumentHtml(d, "");
    expect(staticDocumentHtml(d, "")).toBe(first);
    expect(staticDocumentHtml(d, "cache")).toContain("search-highlight");
    // A new revision is a new document object and is rendered afresh.
    expect(staticDocumentHtml(doc(p(text("next"))), "")).toContain("next");
  });
});
