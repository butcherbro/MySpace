import { Fragment } from "react";
import "./highlight.css";

interface HighlightedTextProps {
  text: string;
  /** The query to highlight. Treated as literal text (never a RegExp). */
  query: string;
}

interface Part {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into match/non-match fragments for a case-insensitive literal
 * `query`. Empty query produces a single non-match fragment. Uses `indexOf`
 * (not a RegExp), so special characters like `.`, `(`, `[` are matched
 * literally and Cyrillic is handled by `toLowerCase`.
 */
function splitMatches(text: string, query: string): Part[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];

  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = q.toLocaleLowerCase();
  const parts: Part[] = [];
  let cursor = 0;

  while (cursor <= text.length) {
    const idx = lowerText.indexOf(lowerQuery, cursor);
    if (idx === -1) {
      if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }

  return parts.length > 0 ? parts : [{ text, match: false }];
}

/**
 * Renders text with matching substrings wrapped in `<mark>` React fragments.
 * Never uses `dangerouslySetInnerHTML`: every character stays inside a React
 * text node, so no HTML/script injection is possible.
 */
export function HighlightedText({ text, query }: HighlightedTextProps) {
  const parts = splitMatches(text, query);
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="search-highlight">
            {part.text}
          </mark>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}