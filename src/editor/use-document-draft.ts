import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { registerDraftFlusher } from "./draft-flush-registry";
import { clearDraftHandoff, readDraftHandoff } from "./draft-handoff";
import type { DocumentSave, DocumentSaveConflict, DraftLineage } from "./corrupt-document";

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
 * `onUpdate(id, doc, options)` must reject on failure so the caller can keep the
 * editor open and the draft visible. `onSaved()` fires after a successful flush
 * so the parent can close editing consistently. Every save carries the draft's
 * `base` (the stored document it was edited from) and its lineage; a save that
 * resolves with a `DocumentSaveConflict` found another writer's text there: the
 * draft then shows the stored document, and its own text lives on in the
 * conflict copy (where editing may move).
 */
export function useDocumentDraft(opts: {
  id: string;
  persistedDocument: unknown;
  onUpdate: DocumentSave;
  onFinalize?: DocumentSave;
  onSaved?: () => void;
  /** The stored document is corrupt: never save (P1.7). */
  corrupt?: boolean;
  /** The card is being edited now (notes): a hand-off to a conflict copy ends with that editing. */
  editing?: boolean;
}) {
  const { id, persistedDocument, onUpdate, onFinalize, onSaved, corrupt = false, editing } = opts;
  const corruptRef = useRef(corrupt);
  useLayoutEffect(() => {
    corruptRef.current = corrupt;
  }, [corrupt]);
  const editingRef = useRef(editing);
  useLayoutEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // Черновик, которому передали правку (копия конфликта), начинает её с
  // новейшего текста оригинала, а не с копии, какой она была создана. Текст
  // читается в том же рендере, где редактор оригинала закрывается.
  const [seed, setSeed] = useState(() => (editing ? readDraftHandoff(id) : undefined));
  const [wasEditing, setWasEditing] = useState(editing);
  const initial = seed === undefined ? persistedDocument : seed;
  const [draft, setDraft] = useState<unknown>(initial);
  if (editing !== wasEditing) {
    setWasEditing(editing);
    const offered = editing ? readDraftHandoff(id) : undefined;
    if (offered !== undefined) {
      setSeed(offered);
      setDraft(offered);
    }
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draftRef = useRef<unknown>(initial);
  const dirtyRef = useRef(false);
  // База черновика: документ из хранилища, от которого он правится.
  const persistedRef = useRef<unknown>(persistedDocument);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Линия, чей finalize сейчас в полёте: блокирует повторный finalize только
  // своей правки, а не новой сессии после сдачи прежней линии в копию.
  const savingLineRef = useRef<DraftLineage | null>(null);
  const needsFinalizeRef = useRef(false);
  // Все сохранения одной правки делят этот объект; `latest` — её новейший документ.
  const lineageRef = useRef<DraftLineage>({ latest: initial });
  // Правка ушла в копию конфликта (`handedToRef`), а редактор оригинала ещё не
  // закрылся: набранное в нём уходит в копию, и его blur не завершает редактирование.
  const handedOffRef = useRef(false);
  const handedToRef = useRef<string | null>(null);
  // Линии, сданные в копию: поздние ответы их сохранений (например, finalize
  // от blur при закрытии) ничего не решают и не завершают правку, которая идёт
  // в копии. Набор, а не одна линия: сдач за жизнь карточки может быть несколько.
  const retiredLinesRef = useRef(new WeakSet<DraftLineage>());

  const clearDebounce = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, []);

  // База читается, когда сохранение дошло до очереди, и сдвигается в момент,
  // когда запись подтверждена (`confirmed`): своё же прошлое сохранение, ещё
  // летевшее при постановке этого, не выглядит чужой правкой.
  const send = useCallback(
    async (save: DocumentSave, doc: unknown) => {
      const lineage = lineageRef.current;
      let confirmed = false;
      const conflict = await save(id, doc, {
        base: () => persistedRef.current,
        confirmed: (stored) => {
          confirmed = true;
          persistedRef.current = stored;
        },
        draft: lineage,
      });
      if (!conflict && !confirmed) persistedRef.current = doc;
      // Ответ за прежнюю линию (после сдачи правки в копию) уже ничего не решает.
      const retired = handedOffRef.current || retiredLinesRef.current.has(lineage);
      return { conflict: conflict && lineage === lineageRef.current && !retired ? conflict : null, retired };
    },
    [id],
  );

  // The draft's newest text goes to the conflict copy (the saver writes it
  // there for a lineage whose conflict is settled); the answer is not awaited.
  const forwardToCopy = useCallback(() => {
    clearDebounce();
    if (!dirtyRef.current || corruptRef.current) return;
    void onUpdate(id, draftRef.current, { draft: lineageRef.current }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [id, onUpdate, clearDebounce]);

  const showStored = useCallback(
    (stored: unknown) => {
      clearDebounce();
      dirtyRef.current = false;
      needsFinalizeRef.current = false;
      handedOffRef.current = false;
      persistedRef.current = stored;
      draftRef.current = stored;
      lineageRef.current = { latest: stored };
      setDraft(stored);
      setError(null);
    },
    [clearDebounce],
  );

  const settleConflict = useCallback(
    (conflict: DocumentSaveConflict) => {
      persistedRef.current = conflict.stored;
      if (conflict.copyId === null) {
        // Текст пользователя уже и есть сохранённый: копии нет, правка идёт дальше от него.
        lineageRef.current = { latest: draftRef.current };
        if (JSON.stringify(draftRef.current) === JSON.stringify(conflict.stored)) {
          clearDebounce();
          dirtyRef.current = false;
          needsFinalizeRef.current = false;
        }
        return;
      }
      forwardToCopy();
      // Редактор оригинала мог закрыться (правка уже в копии) раньше, чем
      // вернулся конфликт: эффект на [editing] отработал впустую и больше не
      // запустится, поэтому завершаем передачу здесь же.
      if (conflict.editingMovedTo !== null && !editingRef.current) {
        retiredLinesRef.current.add(lineageRef.current);
        clearDraftHandoff(conflict.editingMovedTo);
        showStored(conflict.stored);
        return;
      }
      if (conflict.editingMovedTo !== null) {
        handedOffRef.current = true;
        handedToRef.current = conflict.editingMovedTo;
        return;
      }
      showStored(conflict.stored);
    },
    [forwardToCopy, showStored, clearDebounce],
  );

  // The hand-off ends with the original's editing: it shows the stored text.
  // A new editing session never starts handed off.
  useEffect(() => {
    if (!handedOffRef.current) return;
    if (editing) {
      handedOffRef.current = false;
      return;
    }
    forwardToCopy();
    // Копия уже смонтирована в том же коммите и прочла новейший текст.
    if (handedToRef.current !== null) clearDraftHandoff(handedToRef.current);
    handedToRef.current = null;
    // Ответ finalize этой линии, поставленный blur до конфликта, ещё может прийти.
    retiredLinesRef.current.add(lineageRef.current);
    showStored(persistedRef.current);
  }, [editing, forwardToCopy, showStored]);

  // Adopt an externally-changed document only while clean.
  useEffect(() => {
    if (dirtyRef.current) return;
    if (persistedDocument !== persistedRef.current) {
      persistedRef.current = persistedDocument;
      draftRef.current = persistedDocument;
      lineageRef.current = { latest: persistedDocument };
      setDraft(persistedDocument);
    }
  }, [persistedDocument]);

  const finalize = useCallback(
    async (doc: unknown) => {
      // Enter снимает фокус с редактора, поэтому blur может прийти до ответа
      // backend. Одна пользовательская финализация должна дать ровно одну
      // транзакцию смены типа карточки.
      const lineage = lineageRef.current;
      if (savingLineRef.current === lineage) return;
      setSaving(true);
      savingLineRef.current = lineage;
      setError(null);
      try {
        const { conflict, retired } = await send(onFinalize ?? onUpdate, doc);
        if (conflict) {
          settleConflict(conflict);
          if (conflict.editingMovedTo === null && !dirtyRef.current) onSaved?.();
          return;
        }
        if (retired) return;
        dirtyRef.current = false;
        needsFinalizeRef.current = false;
        onSaved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (savingLineRef.current === lineage) {
          setSaving(false);
          savingLineRef.current = null;
        }
      }
    },
    [onFinalize, onSaved, onUpdate, send, settleConflict],
  );

  // An ordinary save of `doc` (autosave, or a reload's flush): editing goes on.
  const update = useCallback(
    async (doc: unknown) => {
      try {
        const { conflict } = await send(onUpdate, doc);
        if (conflict) {
          settleConflict(conflict);
          return;
        }
        if (draftRef.current === doc && !handedOffRef.current) dirtyRef.current = false;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [onUpdate, send, settleConflict],
  );

  // A handed-over draft starts dirty: it is saved at once, and the offer is used up.
  const appliedSeedRef = useRef<unknown>(undefined);
  useLayoutEffect(() => {
    if (seed === undefined || appliedSeedRef.current === seed) return;
    appliedSeedRef.current = seed;
    clearDraftHandoff(id);
    dirtyRef.current = true;
    needsFinalizeRef.current = true;
    draftRef.current = seed;
    lineageRef.current = { latest: seed };
    void update(seed);
  }, [seed, id, update]);

  const handleChange = useCallback(
    (doc: unknown) => {
      if (corruptRef.current) return;
      dirtyRef.current = true;
      needsFinalizeRef.current = true;
      draftRef.current = doc;
      lineageRef.current.latest = doc;
      setDraft(doc);
      clearDebounce();
      debounceTimer.current = setTimeout(() => {
        debounceTimer.current = null;
        void update(doc);
      }, 250);
    },
    [update, clearDebounce],
  );

  const handleBlur = useCallback(() => {
    clearDebounce();
    if (corruptRef.current) {
      onSaved?.();
      return;
    }
    if (handedOffRef.current) {
      forwardToCopy();
      return;
    }
    if (dirtyRef.current || needsFinalizeRef.current) {
      void finalize(draftRef.current);
    } else {
      onSaved?.();
    }
  }, [finalize, onSaved, forwardToCopy, clearDebounce]);

  const handleFinalize = useCallback(() => {
    clearDebounce();
    if (corruptRef.current) return Promise.resolve();
    if (handedOffRef.current) {
      forwardToCopy();
      return Promise.resolve();
    }
    if (dirtyRef.current || needsFinalizeRef.current) {
      return finalize(draftRef.current);
    }
    onSaved?.();
    return Promise.resolve();
  }, [finalize, onSaved, forwardToCopy, clearDebounce]);

  // A reload of the open board: a dirty draft is saved as by the autosave, and
  // editing goes on.
  const saveNow = useCallback(() => {
    if (corruptRef.current || !dirtyRef.current || savingLineRef.current === lineageRef.current) return Promise.resolve();
    clearDebounce();
    return update(draftRef.current);
  }, [update, clearDebounce]);

  // Flush any dirty draft on unmount (navigation/trash/snapshot swap) so a
  // pending debounce is never abandoned. Fire-and-forget: the parent owns
  // reconciliation via its own queue/flush.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (dirtyRef.current && savingLineRef.current !== lineageRef.current && !corruptRef.current) {
        const doc = draftRef.current;
        dirtyRef.current = false;
        void send(onUpdate, doc).catch(() => {
          // Best-effort on unmount; surface via parent banner.
        });
      }
    };
  }, [onUpdate, send]);

  // Register with the cross-cutting draft barrier for as long as this draft is
  // mounted, so a caller (board navigation's `drainPendingWrites`) can flush a
  // dirty draft *before* replacing the projection, instead of racing the
  // unmount-flush above, which only fires after the projection has already
  // swapped (see draft-flush-registry.ts for why that is too late).
  useEffect(() => {
    return registerDraftFlusher((mode) => (mode === "save" ? saveNow() : handleFinalize()));
  }, [handleFinalize, saveNow]);

  // Seed a fresh document (Repair of a corrupt card, P1.7): a dirty draft the
  // next blur/finalize persists; no debounced save is scheduled.
  const replaceDraft = useCallback(
    (doc: unknown) => {
      clearDebounce();
      dirtyRef.current = true;
      needsFinalizeRef.current = true;
      draftRef.current = doc;
      lineageRef.current.latest = doc;
      setDraft(doc);
    },
    [clearDebounce],
  );

  return { draft, saving, error, handleChange, handleBlur, handleFinalize, replaceDraft };
}
