import { useEffect, useRef, useState } from "react";
import type { NoteCardDto } from "../../services/workspace-gateway";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  onUpdate: (id: string, plainText: string) => Promise<void>;
}

/**
 * A minimal editable note. For Slice 1 the surface is a plain-text textarea
 * backed by the durable note document; rich-text (Tiptap) arrives in Slice 3.
 * Editing is local state; persistence is triggered on blur (and Enter without
 * Shift) via the parent-provided `onUpdate` callback.
 */
export function NoteCard({ note, onUpdate }: NoteCardProps) {
  const [text, setText] = useState(note.plainText);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      setEditing(false);
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
    }
  }

  return (
    <div
      className={`note-card ${editing ? "note-card--editing" : ""}`}
      data-testid="note-card"
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
        <div
          className="note-card__text"
          onClick={() => setEditing(true)}
          role="button"
          tabIndex={0}
        >
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
