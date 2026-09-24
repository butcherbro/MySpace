import { memo, useEffect, useMemo, useRef } from "react";
import { NoteEditor } from "./NoteEditor";
import { staticDocumentHtml } from "./static-document";
import { openExternalUrl } from "../services/url-opener";
import "./note-editor.css";

interface StaticDocumentProps {
  /** The authoritative ProseMirror document to display. */
  document: unknown;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
}

const noop = () => {};

/**
 * Read-only display of a rich-text document without a Tiptap editor (P1.8).
 *
 * Renders the HTML Tiptap's serializer produces for the same extension list
 * the editor uses, inside the same `.note-editor > .ProseMirror` structure, so
 * the idle card looks and lays out like the editor it stands in for. Mounting
 * a real editor is left to the one card being edited.
 *
 * Link clicks behave like the read-only editor's: they open in the OS browser
 * and never bubble into React Flow as a card click (which would enter editing).
 *
 * A document the schema can't parse falls back to the read-only editor, which
 * is what every idle card used before, so a malformed row still renders.
 */
export const StaticDocument = memo(function StaticDocument({
  document,
  highlightQuery = "",
}: StaticDocumentProps) {
  const html = useMemo(() => staticDocumentHtml(document, highlightQuery), [document, highlightQuery]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !root!.contains(anchor)) return;
      e.preventDefault();
      e.stopPropagation();
      void openExternalUrl(anchor.href);
    }
    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [html]);

  if (html === null) {
    return <NoteEditor document={document} editable={false} onChange={noop} highlightQuery={highlightQuery} />;
  }

  return (
    <div className="note-editor note-editor--static">
      <div
        ref={rootRef}
        className="tiptap ProseMirror note-editor__static"
        data-static-document="true"
        translate="no"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});
