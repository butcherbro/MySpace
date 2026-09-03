import { useEffect, useRef, useState } from "react";
import { plainTextToDocument } from "../../editor/document-codec";
import type { NoteCardDto } from "../../services/workspace-gateway";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  /** Whether this note is the one currently being edited. */
  editing: boolean;
  /** Exit edit mode. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
  /** Request a context menu (right-click) for this card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
}

/**
 * An editable note. Editing is *controlled* by the parent (the current-board
 * store): the canvas decides click-versus-drag, then flips `editing` on only
 * for a pure click. The note itself only manages the in-editor text buffer.
 */
export function NoteCard({
  note,
  editing,
  onDeactivate,
  onUpdate,
  onContextMenu,
  onResize,
}: NoteCardProps) {
  const [text, setText] = useState(note.plainText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  // Local size while dragging; the authoritative size lives in `note.frame`.
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);

  const appliedWidth = draftSize?.width ?? note.frame.width;
  const appliedHeight = draftSize?.height ?? note.frame.height;

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus();
      autoResize();
    }
  }, [editing]);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function onResizePointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      w: note.frame.width,
      h: note.frame.height,
    };
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    const w = Math.max(120, resizeStart.current.w + dx);
    const h = Math.max(48, resizeStart.current.h + dy);
    setDraftSize({ width: w, height: h });
  }

  function onResizeUp() {
    resizeStart.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    // Persist the final size once.
    if (draftSize) {
      onResize(note.id, draftSize.width, draftSize.height);
      setDraftSize(null);
    }
  }

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onUpdate(note.id, plainTextToDocument(text));
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
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
    >
      {editing ? (
        <textarea
          ref={textareaRef}
          className="note-card__textarea nodrag nopan nowheel"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
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
      <div
        className="note-card__resize nodrag nopan"
        data-testid="note-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
