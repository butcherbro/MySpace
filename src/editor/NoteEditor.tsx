import { useEffect } from "react";
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react";
import { createEditorExtensions } from "./editor-extensions";
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
}

/**
 * The open-source Tiptap editor, isolated behind this component. `NoteCard`
 * (and future cards) talk to `NoteEditor` via a `document` + `onChange`
 * contract, so Tiptap types never leak outside this file.
 */
export function NoteEditor({ document, editable, onChange, onBlur }: NoteEditorProps) {
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
    />
  );
}
