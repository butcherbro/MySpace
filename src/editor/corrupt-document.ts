// P1.7: a card whose stored document could not be parsed arrives with
// `corrupt: true`, an empty `documentJson` and its last stored plain text (the
// only recoverable content). The card shows that text read-only and never
// autosaves; "Repair" seeds a fresh document from the text, opens the editor,
// and the first save carries `acknowledgeCorrupt: true` so the backend accepts
// overwriting the corrupt row. The receipt-driven store update then clears
// `corrupt` and the card is normal again.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

/** Options a text write can carry (see `UpdateNoteInput.acknowledgeCorrupt`). */
export interface DocumentSaveOptions {
  /** Overwrite a stored document that is corrupt (P1.7). */
  acknowledgeCorrupt?: boolean;
  /**
   * The stored document the draft is edited from, read when the save runs:
   * any other stored text was written by someone else.
   */
  base?: () => unknown;
  /** Called with the document the moment it is stored, before later saves in the queue run. */
  confirmed?: (document: unknown) => void;
  /** The draft this save belongs to; every save of one draft carries the same object. */
  draft?: DraftLineage;
}

/** One draft's saves share this object; `latest` is its newest document. */
export interface DraftLineage {
  latest: unknown;
}

/**
 * What a save resolves with when someone else changed the stored text since
 * `base` (see `useCardEdits`): the draft must show `stored` and never save
 * itself over it. The user's text went to the conflict copy `copyId` (`null`:
 * it already equalled `stored`), later saves of the same draft go there too;
 * `editingMovedTo` is the copy now being edited, or `null` (the editor ends as
 * after a save).
 */
export interface DocumentSaveConflict {
  stored: unknown;
  copyId: string | null;
  editingMovedTo: string | null;
}

/** A text-card persist callback that accepts {@link DocumentSaveOptions}. */
export type DocumentSave = (
  id: string,
  document: unknown,
  options?: DocumentSaveOptions,
) => Promise<void | DocumentSaveConflict>;

/** A fresh document holding the recovered plain text, one paragraph per line. */
export function recoveredDocument(plainText: string): unknown {
  const lines = plainText.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : [],
    })),
  };
}

/**
 * Repair state of one text card. `damaged` is true while the card is corrupt
 * and the user has not started a repair: the card then renders the recovered
 * text and the draft hook must not save. The returned save callbacks are
 * stable and add `acknowledgeCorrupt: true` only while a repair is underway.
 */
export function useCorruptRepair(opts: {
  corrupt: boolean;
  onUpdate: DocumentSave;
  onFinalize?: DocumentSave;
}) {
  const { corrupt, onUpdate, onFinalize } = opts;
  const [repairing, setRepairing] = useState(false);
  // The store cleared `corrupt` (a repaired save landed): back to normal.
  if (repairing && !corrupt) setRepairing(false);

  const acknowledge = corrupt && repairing;
  const acknowledgeRef = useRef(acknowledge);
  useLayoutEffect(() => {
    acknowledgeRef.current = acknowledge;
  }, [acknowledge]);

  // Healthy cards pass the draft's options through unchanged.
  const save = (fn: DocumentSave, id: string, document: unknown, options?: DocumentSaveOptions) =>
    acknowledgeRef.current ? fn(id, document, { ...options, acknowledgeCorrupt: true }) : fn(id, document, options);
  const update = useCallback(
    (id: string, document: unknown, options?: DocumentSaveOptions) => save(onUpdate, id, document, options),
    [onUpdate],
  );
  const finalize = useMemo(
    () =>
      onFinalize
        ? (id: string, document: unknown, options?: DocumentSaveOptions) => save(onFinalize, id, document, options)
        : undefined,
    [onFinalize],
  );
  const beginRepair = useCallback(() => {
    acknowledgeRef.current = true;
    setRepairing(true);
  }, []);

  return { damaged: corrupt && !repairing, beginRepair, onUpdate: update, onFinalize: finalize };
}
