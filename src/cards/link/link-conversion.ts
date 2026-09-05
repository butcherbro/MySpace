// Pure classification of note content for automatic Link Card conversion.
//
// This is deliberately UI/Tiptap/React-free: it accepts normalized serializable
// document data (a ProseMirror-shaped `doc`) and answers a single question:
// "is this Note semantically exactly one absolute HTTP(S) URL?". Everything
// else (React, the editor view, the gateway) consumes this predicate without
// depending on it.

import type { NoteNode } from "../../editor/note-document";

export type LinkConversionResult =
  | { qualifies: true; url: string }
  | { qualifies: false; reason: LinkConversionReason };

export type LinkConversionReason =
  | "empty"
  | "multiple-urls"
  | "has-other-content"
  | "not-web-url";

const ALLOWED_PROTOCOLS = ["http:", "https:"];

/**
 * A node is "semantically significant" if it carries any text or an embedded
 * image. Empty paragraphs, empty headings, or empty lists are ignored so that
 * trailing whitespace and a stray empty line never disqualify a lone URL.
 */
function hasSemanticContent(node: NoteNode): boolean {
  if (typeof node.text === "string" && node.text.trim().length > 0) {
    return true;
  }
  if (node.type === "hardBreak") {
    return false;
  }
  // An embedded image node carries an explicit `src`/`asset` attribute and is
  // semantic even without text, so a lone URL next to an image never converts.
  const attrs = node.attrs;
  if (attrs && ("src" in attrs || "assetId" in attrs)) {
    return true;
  }
  return (node.content ?? []).some(hasSemanticContent);
}

/** Returns every non-empty text run in the document, in document order. */
function textFragments(nodes: NoteNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node.text === "string") {
      out.push(node.text);
    }
    if (node.content) {
      out.push(...textFragments(node.content));
    }
  }
  return out;
}

/** A URL is valid when parseable and using http/https. */
function isWebUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.includes(parsed.protocol);
}

function extractUrls(text: string): string[] {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  return tokens.filter((t) => {
    if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
    try {
      new URL(t);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Evaluates the automatic-conversion predicate for a note document.
 *
 * A document qualifies only when, after ignoring outer whitespace and empty
 * blocks, its entire semantic content is exactly one valid absolute HTTP(S)
 * URL. Any other text, a second URL, a list, or an embedded image disqualifies it.
 */
export function classifyLinkConversion(doc: unknown): LinkConversionResult {
  if (typeof doc !== "object" || doc === null) {
    return { qualifies: false, reason: "empty" };
  }
  const root = doc as { type?: string; content?: NoteNode[] };
  if (root.type !== "doc" || !Array.isArray(root.content)) {
    return { qualifies: false, reason: "empty" };
  }

  // First: a cheap, semantics-aware empty check. If there is nothing but empty
  // paragraphs/whitespace, there is nothing to convert.
  if (!root.content.some(hasSemanticContent)) {
    return { qualifies: false, reason: "empty" };
  }

  // Second: any non-paragraph top-level block (heading, list, blockquote,
  // image, etc.) disqualifies. The spec requires "no list markers, embedded
  // images, or non-empty blocks"; a URL that lives inside a heading or a
  // bullet list is presentational content, not a bare URL note.
  if (!root.content.every((n) => n.type === "paragraph")) {
    return { qualifies: false, reason: "has-other-content" };
  }

  // Third: collect every non-empty text fragment, trim the whole concatenation,
  // and reject anything that is not a single web URL token.
  const allText = textFragments(root.content)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .trim();

  if (allText.length === 0) {
    return { qualifies: false, reason: "empty" };
  }

  const urls = extractUrls(allText);

  if (urls.length === 0) {
    return { qualifies: false, reason: "not-web-url" };
  }
  if (urls.length > 1) {
    return { qualifies: false, reason: "multiple-urls" };
  }

  // Exactly one URL token was found. It qualifies only if it is the *entire*
  // content (no surrounding words). Since `urls.length === 1`, compare the URL
  // against the trimmed content directly.
  if (allText !== urls[0]) {
    return { qualifies: false, reason: "has-other-content" };
  }

  if (!isWebUrl(urls[0])) {
    return { qualifies: false, reason: "not-web-url" };
  }

  return { qualifies: true, url: urls[0] };
}
