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
}

/** A text-card persist callback that accepts {@link DocumentSaveOptions}. */
export type DocumentSave = (id: string, document: unknown, options?: DocumentSaveOptions) => Promise<void>;

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

  // Healthy cards call through unchanged (no third argument).
  const save = (fn: DocumentSave, id: string, document: unknown) =>
    acknowledgeRef.current ? fn(id, document, { acknowledgeCorrupt: true }) : fn(id, document);
  const update = useCallback(
    (id: string, document: unknown) => save(onUpdate, id, document),
    [onUpdate],
  );
  const finalize = useMemo(
    () => (onFinalize ? (id: string, document: unknown) => save(onFinalize, id, document) : undefined),
    [onFinalize],
  );
  const beginRepair = useCallback(() => {
    acknowledgeRef.current = true;
    setRepairing(true);
  }, []);

  return { damaged: corrupt && !repairing, beginRepair, onUpdate: update, onFinalize: finalize };
}
