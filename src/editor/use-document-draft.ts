import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerDraftFlusher } from "./draft-flush-registry";

/**
 * Shared document-draft lifecycle for editable rich-text cards (notes and image
 * captions). A document (ProseMirror JSON) is the authoritative content; this
 * hook owns:
 *
 * - a transient `draft` marked `dirty` on change,
 * - debounced autosave (250 ms),
 * - flush-on-blur (immediate persist + clean),
 * - **flush-on-unmount** — because navigation swaps the board projection and the
 *   component unmounts before a debounced save can be enqueued, the cleanup must
 *   push any dirty draft out itself,
 * - incoming `persistedDocument` is adopted only while clean (snapshot reload /
 *   undo / restore never clobber an in-progress edit).
 *
 * P1.7: while `corrupt` is true (the stored document could not be parsed and
 * the card shows recovered plain text) the hook never writes: no debounced
 * save, no blur/finalize/unmount/barrier flush. `replaceDraft` seeds a fresh
 * document (the Repair action) as a dirty draft without scheduling a save;
 * the next blur/finalize persists it.
 *
 * `onUpdate(id, doc)` must reject on failure so the caller can keep the editor
 * open and the draft visible. `onSaved()` fires after a successful flush so the
 * parent can close editing consistently.
 */
export function useDocumentDraft(opts: {
  id: string;
  persistedDocument: unknown;
  onUpdate: (id: string, document: unknown) => Promise<void>;
  onFinalize?: (id: string, document: unknown) => Promise<void>;
  onSaved?: () => void;
  /** The stored document is corrupt: never save (P1.7). */
  corrupt?: boolean;
}) {
  const { id, persistedDocument, onUpdate, onFinalize, onSaved, corrupt = false } = opts;
  const corruptRef = useRef(corrupt);
  useLayoutEffect(() => {
    corruptRef.current = corrupt;
  }, [corrupt]);

  const [draft, setDraft] = useState<unknown>(persistedDocument);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftRef = useRef<unknown>(persistedDocument);
  const dirtyRef = useRef(false);
  const persistedRef = useRef<unknown>(persistedDocument);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const needsFinalizeRef = useRef(false);

  // Adopt an externally-changed document only while clean.
  useEffect(() => {
    if (dirtyRef.current) return;
    if (persistedDocument !== persistedRef.current) {
      persistedRef.current = persistedDocument;
      draftRef.current = persistedDocument;
      setDraft(persistedDocument);
    }
  }, [persistedDocument]);

  const finalize = useCallback(
    async (doc: unknown) => {
      // Enter снимает фокус с редактора, поэтому blur может прийти до ответа
      // backend. Одна пользовательская финализация должна дать ровно одну
      // транзакцию смены типа карточки.
      if (savingRef.current) return;
      setSaving(true);
      savingRef.current = true;
      setError(null);
      try {
        await (onFinalize ? onFinalize(id, doc) : onUpdate(id, doc));
        dirtyRef.current = false;
        persistedRef.current = doc;
        needsFinalizeRef.current = false;
        onSaved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
        savingRef.current = false;
      }
    },
    [id, onFinalize, onSaved, onUpdate],
  );

  const handleChange = useCallback(
    (doc: unknown) => {
      if (corruptRef.current) return;
      dirtyRef.current = true;
      needsFinalizeRef.current = true;
      draftRef.current = doc;
      setDraft(doc);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        onUpdate(id, doc)
          .then(() => {
            if (draftRef.current === doc) {
              dirtyRef.current = false;
              persistedRef.current = doc;
            }
          })
          .catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
          });
      }, 250);
    },
    [id, onUpdate],
  );

  const handleBlur = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (corruptRef.current) {
      onSaved?.();
      return;
    }
    if (dirtyRef.current || needsFinalizeRef.current) {
      void finalize(draftRef.current);
    } else {
      onSaved?.();
    }
  }, [finalize, onSaved]);

  const handleFinalize = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (corruptRef.current) return Promise.resolve();
    if (dirtyRef.current || needsFinalizeRef.current) {
      return finalize(draftRef.current);
    }
    onSaved?.();
    return Promise.resolve();
  }, [finalize, onSaved]);

  // Flush any dirty draft on unmount (navigation/trash/snapshot swap) so a
  // pending debounce is never abandoned. Fire-and-forget: the parent owns
  // reconciliation via its own queue/flush.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (dirtyRef.current && !savingRef.current && !corruptRef.current) {
        const doc = draftRef.current;
        dirtyRef.current = false;
        void onUpdate(id, doc).catch(() => {
          // Best-effort on unmount; surface via parent banner.
        });
      }
    };
  }, [id, onUpdate]);

  // Register with the cross-cutting draft barrier for as long as this draft is
  // mounted, so a caller (board navigation's `drainPendingWrites`) can flush a
  // dirty draft *before* replacing the projection, instead of racing the
  // unmount-flush above, which only fires after the projection has already
  // swapped (see draft-flush-registry.ts for why that is too late).
  useEffect(() => {
    return registerDraftFlusher(handleFinalize);
  }, [handleFinalize]);

  // Seed a fresh document (Repair of a corrupt card, P1.7): a dirty draft the
  // next blur/finalize persists; no debounced save is scheduled.
  const replaceDraft = useCallback((doc: unknown) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    dirtyRef.current = true;
    needsFinalizeRef.current = true;
    draftRef.current = doc;
    setDraft(doc);
  }, []);

  return { draft, saving, error, handleChange, handleBlur, handleFinalize, replaceDraft };
}
