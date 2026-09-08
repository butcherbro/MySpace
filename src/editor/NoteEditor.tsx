import { useEffect } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { createEditorExtensions } from "./editor-extensions";
import { openExternalUrl } from "../services/url-opener";
import { classifyLinkConversion } from "../cards/link/link-conversion";
import { setSearchHighlight } from "./search-highlight";
import "./note-editor.css";

interface NoteEditorProps {
  /** The authoritative ProseMirror document (initial content). */
  document: unknown;
  /** Whether the editor is editable. */
  editable: boolean;
  /** Called with the full ProseMirror JSON whenever content changes. */
  onChange: (document: unknown) => void;
  /** Called when the editor loses focus. */
  onBlur?: () => void;
  /** Called when Enter should finalize a bare-URL note instead of inserting a line. */
  onFinalize?: () => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
}

/**
 * The open-source Tiptap editor, isolated behind this component. `NoteCard`
 * (and future cards) talk to `NoteEditor` via a `document` + `onChange`
 * contract, so Tiptap types never leak outside this file.
 */
export function NoteEditor({
  document,
  editable,
  onChange,
  onBlur,
  onFinalize,
  highlightQuery = "",
}: NoteEditorProps) {
  const editor = useEditor({
    extensions: createEditorExtensions(),
    content: document as JSONContent,
    editable,
    onUpdate: ({ editor }) => {
      onChange(editor.getJSON());
    },
    onBlur: () => {
      onBlur?.();
    },
  });

  // Reflect external document changes (e.g. a snapshot reload) into the editor.
  useEffect(() => {
    if (!editor) return;
    const doc = document as { type?: string } | null;
    if (doc && doc.type === "doc") {
      const current = JSON.stringify(editor.getJSON());
      const incoming = JSON.stringify(document);
      if (current !== incoming) {
        editor.commands.setContent(document as JSONContent);
      }
    }
  }, [document, editor]);

  // Apply (or clear) the transient highlight. This dispatches a meta-only
  // transaction, so `onUpdate`/`onChange` never fire and the document is never
  // rewritten. The plugin itself is registered at editor creation via the
  // extension list, so no state-replacing `registerPlugin` call happens here.
  useEffect(() => {
    if (!editor) return;
    setSearchHighlight(editor, highlightQuery);
  }, [editor, highlightQuery]);

  // Keep the editable flag in sync with the external prop. `useEditor` only
  // applies `editable` at creation time, so toggling it after mount requires an
  // explicit setEditable call.
  useEffect(() => {
    editor?.setEditable(editable);
    // Focus the editor the moment editing begins, mirroring the old textarea
    // autofocus, so that a subsequent click-outside fires a clean blur. We do
    // not force a caret position (`focus("end")`) so the caret lands where the
    // user clicked rather than always at the end.
    if (editable) {
      editor?.commands.focus();
    }
  }, [editor, editable]);

  // In display mode (not editing), a click on an inline link should open it in
  // the OS browser and must NOT bubble up into React Flow as a drag or an
  // edit-entry. We attach a capture listener on the editor root: it only acts on
  // `a[href]` clicks while `!editable`, opening the URL and stopping propagation.
  // (Tiptap's Link `openOnClick` only fires while editable and uses `window.open`,
  // which is wrong for a spatial card and the Tauri WebView, so we handle it here.)
  useEffect(() => {
    if (!editor || editable) return;
    const root = editor.view.dom;

    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || !root.contains(anchor)) return;

      e.preventDefault();
      e.stopPropagation();
      void openExternalUrl(anchor.href);
    }

    root.addEventListener("click", onClick, true);
    return () => root.removeEventListener("click", onClick, true);
  }, [editor, editable]);

  if (!editor) return null;

  // `nodrag`/`nopan` are only applied while editing so text selection never
  // collides with card drag; in display mode the card's whole surface must remain
  // draggable. No `nowheel` here either, to avoid swallowing pointer events that
  // React Flow needs for click/selection/drag.
  const interactiveClass = editable ? " nodrag nopan" : "";

  return (
    <EditorContent
      editor={editor}
      className={`note-editor${interactiveClass}`}
      onKeyDownCapture={(event) => {
        if (!editable || !onFinalize) return;
        if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        if (event.nativeEvent.isComposing) return;

        const classification = classifyLinkConversion(editor.getJSON());
        if (!classification.qualifies) return;

        event.preventDefault();
        event.stopPropagation();
        onFinalize();
      }}
    />
  );
}
