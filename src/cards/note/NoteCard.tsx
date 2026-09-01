import { useEffect, useRef, useState } from "react";
import type { NoteCardDto } from "../../services/workspace-gateway";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  /** Whether this note is the one currently being edited. */
  editing: boolean;
  /** Exit edit mode. */
  onDeactivate: () => void;
  onUpdate: (id: string, plainText: string) => Promise<void>;
}

/**
 * An editable note. Editing is *controlled* by the parent (the current-board
 * store): the canvas decides click-versus-drag, then flips `editing` on only
 * for a pure click. The note itself only manages the in-editor text buffer.
 */
export function NoteCard({ note, editing, onDeactivate, onUpdate }: NoteCardProps) {
  const [text, setText] = useState(note.plainText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the local buffer in sync when the authoritative note changes (e.g. a
  // snapshot reload or an external rollback replaces the note). React's
  // recommended "adjusting state during render" pattern for derived state.
  const [prevPlainText, setPrevPlainText] = useState(note.plainText);
  if (prevPlainText !== note.plainText && !editing) {
    setPrevPlainText(note.plainText);
    setText(note.plainText);
  }

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  }, [editing]);

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onUpdate(note.id, text);
      onDeactivate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText(note.plainText);
      onDeactivate();
    }
  }

  return (
    <div
      className={`note-card ${editing ? "note-card--editing" : ""}`}
      data-testid="note-card"
      data-editing={editing ? "true" : "false"}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          className="note-card__textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={handleKeyDown}
          disabled={saving}
        />
      ) : (
        <div className="note-card__text" role="button" tabIndex={0}>
          {text || <span className="note-card__placeholder">Empty note</span>}
        </div>
      )}
      {saving && <div className="note-card__status">Saving…</div>}
      {error && (
        <div className="note-card__status note-card__status--error">{error}</div>
      )}
    </div>
  );
}
