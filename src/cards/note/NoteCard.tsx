import { useCallback, useEffect, useRef, useState } from "react";
import { NoteEditor } from "../../editor/NoteEditor";
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
  /** Request a context menu (right-click) for this card. */
  onContextMenu: (cardId: string, x: number, y: number) => void;
  /** Persist a manual resize (width/height in CSS px). */
  onResize: (id: string, width: number, height: number) => void;
}

/**
 * An editable note backed by an authoritative document. Editing is controlled
 * by the parent; the note holds a transient draft while focused and debounces
 * persistence (plan Task 3.2).
 *
 * Draft lifecycle: the draft tracks the last-persisted document and a `dirty`
 * flag. Incoming `note.documentJson` (snapshot reload, undo, restore) is only
 * adopted while clean — a dirty draft wins so a local edit is never clobbered
 * by a restore. A failed save keeps the editor open and the draft visible.
 */
export function NoteCard({
  note,
  editing,
  onDeactivate,
  onUpdate,
  onContextMenu,
  onResize,
}: NoteCardProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftDocument, setDraftDocument] = useState<unknown>(note.documentJson);

  const draftRef = useRef<unknown>(note.documentJson);
  const dirtyRef = useRef(false);
  const resizeStart = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftSize, setDraftSize] = useState<{ width: number; height: number } | null>(null);
  const draftSizeRef = useRef<{ width: number; height: number } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The document this draft was based on (persisted). Used to detect external
  // changes that arrive while the note is not being edited.
  const persistedDocumentRef = useRef<unknown>(note.documentJson);

  const appliedWidth = draftSize?.width ?? note.frame.width;
  const appliedHeight = draftSize?.height ?? note.frame.height;

  // Adopt an externally-changed document only while the draft is clean (no
  // unsaved local edits). This handles snapshot reload / undo / restore for the
  // same note id without overwriting a user's in-progress text.
  useEffect(() => {
    if (dirtyRef.current) return;
    if (note.documentJson !== persistedDocumentRef.current) {
      persistedDocumentRef.current = note.documentJson;
      draftRef.current = note.documentJson;
      setDraftDocument(note.documentJson);
    }
  }, [note.documentJson]);

  const commit = useCallback(
    async (doc: unknown) => {
      setSaving(true);
      setError(null);
      try {
        await onUpdate(note.id, doc);
        dirtyRef.current = false;
        persistedDocumentRef.current = doc;
        onDeactivate();
      } catch (e) {
        // Keep the editor open and the draft visible; do NOT deactivate.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [note.id, onUpdate, onDeactivate],
  );

  // Debounced autosave while editing (250 ms, plan Task 3.2). Does not deactivate;
  // a successful autosave marks the draft clean and lets App reconcile the note.
  const handleChange = useCallback(
    (doc: unknown) => {
      dirtyRef.current = true;
      draftRef.current = doc;
      setDraftDocument(doc);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const task = onUpdate(note.id, doc);
        task
          .then(() => {
            // Successful autosave: the draft is now clean and matches what was
            // persisted. Reconcile the local base so a later blur doesn't re-save.
            if (draftRef.current === doc) {
              dirtyRef.current = false;
              persistedDocumentRef.current = doc;
            }
          })
          .catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
          });
      }, 250);
    },
    [note.id, onUpdate],
  );

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Guarantee a dirty draft is flushed when the note stops being edited for any
  // reason other than the editor's own blur (e.g. navigation, trash, snapshot
  // reload). The blur handler already covers focus loss; this catches the
  // editing=false-with-a-pending-debounce path so a debounced autosave cannot be
  // abandoned by unmount. `onUpdate` is a side-effect into App (no local setState
  // here), so this does not trip set-state-in-effect.
  useEffect(() => {
    if (!editing) return;
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (dirtyRef.current) {
        const doc = draftRef.current;
        dirtyRef.current = false;
        void onUpdate(note.id, doc).catch(() => {
          // Errors surface via the App banner; the draft is best-effort flushed.
        });
      }
    };
  }, [editing, note.id, onUpdate]);

  // Flush any pending debounce and persist immediately when the editor loses
  // focus (plan: flush on blur). Driven by NoteEditor's onBlur, not a setState
  // in effect.
  const handleBlur = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (dirtyRef.current) {
      void commit(draftRef.current);
    } else {
      onDeactivate();
    }
  }, [commit, onDeactivate]);

  function onResizePointerDown(e: React.PointerEvent) {
    e.stopPropagation();
    // Capture the pointer on the handle so pointermove events keep flowing to
    // this element and React Flow never starts a competing node drag.
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
      data-editing={editing ? "true" : "false"}
      style={{ width: appliedWidth, height: appliedHeight }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(note.id, e.clientX, e.clientY);
      }}
    >
      <NoteEditor
        document={editing ? draftDocument : note.documentJson}
        editable={editing}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      {saving && <div className="note-card__status">Saving…</div>}
      {error && <div className="note-card__status note-card__status--error">{error}</div>}
      <div
        className="note-card__resize nodrag nopan"
        data-testid="note-resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
