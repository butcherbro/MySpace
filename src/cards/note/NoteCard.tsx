import { useRef, useState } from "react";
import { NoteEditor } from "../../editor/NoteEditor";
import { useDocumentDraft } from "../../editor/use-document-draft";
import type { NoteEditorCommands } from "../../editor/editor-commands";
import type { NoteCardDto } from "../../services/workspace-gateway";
import "./note-card.css";

interface NoteCardProps {
  note: NoteCardDto;
  /** Whether this note is the one currently being edited. */
  editing: boolean;
  /** Exit edit mode. */
  onDeactivate: () => void;
  /** Persist note content as an authoritative document. Rejects on failure. */
  onUpdate: (id: string, document: unknown) => Promise<void>;
  /** Finalize note editing (blur/Enter) and optionally convert into a Link Card. */
  onFinalize?: (id: string, document: unknown) => Promise<void>;
  /** Request a context menu (right-click) for this card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
  /** Transient search phrase to highlight (UI-only; never persisted). */
  highlightQuery?: string;
  /** Called with the editing command surface (or null when leaving edit mode). */
  onCommandsReady?: (commands: NoteEditorCommands | null) => void;
  /** Called with the current bold-active state. */
  onBoldStateChange?: (active: boolean) => void;
}

/**
 * An editable note backed by an authoritative document. Editing is controlled
 * by the parent; the draft lifecycle (debounce/flush) lives in the shared
 * `useDocumentDraft` hook.
 */
export function NoteCard({
  note,
  editing,
  onDeactivate,
  onUpdate,
  onFinalize,
  onContextMenu,
  onResize,
  highlightQuery = "",
  onCommandsReady,
  onBoldStateChange,
}: NoteCardProps) {
  const { draft, saving, error, handleChange, handleBlur, handleFinalize } = useDocumentDraft({
    id: note.id,
    persistedDocument: note.documentJson,
    onUpdate,
    onFinalize,
    onSaved: onDeactivate,
  });

  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);

  const appliedWidth = draftSize?.width ?? note.frame.width;
  const appliedHeight = draftSize?.height ?? note.frame.height;

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
    const next = { width: Math.max(120, resizeStart.current.w + dx), height: Math.max(48, resizeStart.current.h + dy) };
    draftSizeRef.current = next;
    setDraftSize(next);
  }

  function onResizeUp() {
    resizeStart.current = null;
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    const final = draftSizeRef.current;
    if (final) {
      onResize(note.id, final.width, final.height);
      draftSizeRef.current = null;
      setDraftSize(null);
    }
  }

  return (
    <div
      className={`note-card ${editing ? "note-card--editing" : ""}`}
      data-testid="note-card"
      data-kind="note"
      data-editing={editing ? "true" : "false"}
      data-saving={saving ? "true" : "false"}
      data-error={error ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
    >
      <NoteEditor
        document={editing ? draft : note.documentJson}
        editable={editing}
        onChange={handleChange}
        onBlur={handleBlur}
        onFinalize={() => {
          void handleFinalize();
        }}
        highlightQuery={highlightQuery}
        onCommandsReady={onCommandsReady}
        onBoldStateChange={onBoldStateChange}
      />
      {saving && <div className="note-card__status note-card__status--saving">Saving…</div>}
      {error && <div className="note-card__status note-card__status--error">{error}</div>}
      <div
        className="note-card__resize nodrag nopan"
        data-testid="note-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
