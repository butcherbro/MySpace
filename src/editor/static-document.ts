// Static (editor-free) rendering of a persisted ProseMirror document.
//
// P1.8: a board with hundreds of notes used to mount one Tiptap/ProseMirror
// editor per card, even though at most one card is ever being edited. Idle
// cards now render the same document as plain HTML, produced by Tiptap's own
// DOM serializer over the *same* extension list the editor uses (so marks,
// headings, lists, links and text colors come out identical), and only the
// card in edit mode mounts a real editor.
//
// Caching: the HTML for a document is memoised by the document object itself
// (WeakMap). A persisted `documentJson` is replaced by a new object whenever
// its card's revision changes, so this is a per-(id, revision) memo that also
// survives the card component unmounting and remounting — which React Flow's
// `onlyRenderVisibleElements` does every time a card scrolls in and out of
// view.

import { getHTMLFromFragment, getSchema, type JSONContent } from "@tiptap/core";
import { Node as PMNode, type Schema } from "@tiptap/pm/model";
import { createEditorExtensions } from "./editor-extensions";

let schema: Schema | null = null;

function editorSchema(): Schema {
  // Building a schema resolves every extension; do it once, not per card.
  schema ??= getSchema(createEditorExtensions());
  return schema;
}

const htmlCache = new WeakMap<object, string | null>();

/** An empty document renders as one empty paragraph, like a fresh editor. */
const EMPTY_DOCUMENT_HTML = "<p></p>";

/**
 * Serializes a ProseMirror JSON document to HTML. Returns `null` when the value
 * is not a document this schema can parse — the caller falls back to the
 * read-only editor, which has its own tolerant handling of bad content.
 */
export function documentToHtml(document: unknown): string | null {
  if (document === null || document === undefined) return EMPTY_DOCUMENT_HTML;
  if (typeof document !== "object") return null;
  const cached = htmlCache.get(document);
  if (cached !== undefined) return cached;

  let html: string | null;
  const doc = document as JSONContent;
  if (doc.type !== "doc") {
    html = null;
  } else if (!Array.isArray(doc.content) || doc.content.length === 0) {
    // `{type: "doc"}` with no content is what a brand-new card stores; the
    // editor opens it as one empty paragraph.
    html = EMPTY_DOCUMENT_HTML;
  } else {
    try {
      const s = editorSchema();
      const node = PMNode.fromJSON(s, doc);
      node.check();
      html = getHTMLFromFragment(node.content, s);
    } catch {
      html = null;
    }
  }
  htmlCache.set(document, html);
  return html;
}

const TEXTBLOCK_SELECTOR = "p, h1, h2, h3";

/**
 * Adds the two things ProseMirror's live DOM has and the serializer output
 * lacks, so the static card lays out exactly like the editor it replaces:
 *
 * - a trailing `<br>` in empty text blocks (and after a trailing hard break),
 *   without which an empty paragraph collapses to zero height;
 * - the transient search highlight (`span.search-highlight`), matched per text
 *   node and case-insensitively, the same way `search-highlight.ts` builds its
 *   decorations.
 */
export function decorateStaticHtml(html: string, highlightQuery: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const root = template.content;

  for (const block of Array.from(root.querySelectorAll(TEXTBLOCK_SELECTOR))) {
    const last = block.lastChild;
    if (!last || (last.nodeType === 1 && (last as Element).tagName === "BR")) {
      const br = document.createElement("br");
      br.className = "ProseMirror-trailingBreak";
      block.appendChild(br);
    }
  }

  const q = highlightQuery.trim().toLowerCase();
  if (q) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);
    for (const textNode of textNodes) {
      const text = textNode.data;
      const lower = text.toLowerCase();
      let idx = lower.indexOf(q);
      if (idx === -1) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      while (idx !== -1) {
        if (idx > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, idx)));
        const span = document.createElement("span");
        span.className = "search-highlight";
        span.textContent = text.slice(idx, idx + q.length);
        fragment.appendChild(span);
        cursor = idx + q.length;
        idx = lower.indexOf(q, cursor);
      }
      if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
      textNode.replaceWith(fragment);
    }
  }

  return template.innerHTML;
}

const decoratedCache = new WeakMap<object, { query: string; html: string | null }>();

/**
 * The HTML an idle card renders for `document` with `highlightQuery` applied,
 * or `null` when the document can't be rendered statically. Memoised per
 * document object (the last query only: search changes rarely, revisions often).
 */
export function staticDocumentHtml(document: unknown, highlightQuery: string): string | null {
  const key = document !== null && typeof document === "object" ? document : null;
  if (key) {
    const hit = decoratedCache.get(key);
    if (hit && hit.query === highlightQuery) return hit.html;
  }
  const base = documentToHtml(document);
  const html = base === null ? null : decorateStaticHtml(base, highlightQuery);
  if (key) decoratedCache.set(key, { query: highlightQuery, html });
  return html;
}
