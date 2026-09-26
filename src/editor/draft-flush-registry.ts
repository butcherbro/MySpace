// Cross-cutting barrier for in-flight document drafts (notes, captions).
//
// `useDocumentDraft` only flushes a dirty draft on blur or on unmount. Board
// navigation replaces the projection and unmounts the editing card *after* its
// own write barrier (`drainPendingWrites`) has already resolved (see
// `useBoardNavigation.navigateTo`), so a debounced draft still inside its
// 250 ms window is otherwise flushed too late: by the time the unmount effect
// runs, `App`'s `cardsRef` already points at the new board and the write is
// silently dropped (the card is no longer found).
//
// Every mounted `useDocumentDraft` instance registers a flush callback here
// while it exists. `flushAllDrafts` — called by `App`'s `drainPendingWrites`
// *before* the mutation queue and viewport are flushed — finalizes every
// dirty draft synchronously, so its write lands in the queue in time for the
// queue flush that follows.

type DraftFlusher = () => Promise<void>;

const flushers = new Set<DraftFlusher>();

/** Registers a flush callback; returns the matching unregister function. */
export function registerDraftFlusher(flush: DraftFlusher): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/**
 * Finalizes every currently-registered draft. Best-effort per draft: a
 * failure is left for the owning hook's own error state to surface, and never
 * blocks the others or the caller.
 */
export async function flushAllDrafts(): Promise<void> {
  const snapshot = Array.from(flushers);
  await Promise.all(
    snapshot.map((flush) =>
      flush().catch(() => {
        // Best-effort; the owning `useDocumentDraft` surfaces its own error.
      }),
    ),
  );
}
