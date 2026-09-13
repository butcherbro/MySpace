import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CanvasViewport } from "../canvas/canvas-types";
import type { WorkspaceGateway } from "../services/workspace-gateway";

/** One debounced viewport write, pinned to the board revision it was captured at. */
export interface PendingViewportSave {
  boardId: string;
  revision: number;
  viewport: CanvasViewport;
}

export interface ViewportPersistence {
  /** Record a settled viewport for `boardId`/`revision` and debounce the save. */
  schedule: (save: PendingViewportSave) => void;
  /** Persist whatever is pending right now and resolve once it has settled. */
  flush: () => Promise<void>;
  /** Drop a pending save without writing it. */
  cancel: () => void;
}

export interface ViewportPersistenceOptions {
  delayMs?: number;
  onSaved?: (save: PendingViewportSave) => void;
  onError?: (error: unknown, save: PendingViewportSave) => void;
}

const DEFAULT_DELAY_MS = 400;

/**
 * Debounced viewport persistence scoped to a board revision.
 *
 * The pending record carries `{ boardId, revision, viewport }` captured when the
 * viewport settled, and the timer writes exactly that record. Reading a shared
 * revision ref when the timer fires is the bug this replaces: navigating from
 * board A to board B within the debounce window would send A's viewport with B's
 * revision, which the backend rejects as stale and which then surfaces a
 * stale-revision banner on the board the user just opened.
 *
 * `flush()` is the navigation barrier: it clears the timer, writes the pending
 * record, and resolves once every in-flight write has settled, so navigation can
 * await it before replacing the projection.
 */
export function useViewportPersistence(
  gateway: WorkspaceGateway,
  options: ViewportPersistenceOptions = {},
): ViewportPersistence {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

  // Handlers are read through a ref so the returned functions stay stable while
  // always calling the latest closure (which sees the current board).
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  const pendingRef = useRef<PendingViewportSave | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());

  const write = useCallback(
    (save: PendingViewportSave): Promise<void> => {
      const attempt = gateway
        .saveViewport({
          boardId: save.boardId,
          expectedRevision: save.revision,
          x: save.viewport.x,
          y: save.viewport.y,
          zoom: save.viewport.zoom,
        })
        .then(
          () => {
            handlers.current.onSaved?.(save);
          },
          (error: unknown) => {
            handlers.current.onError?.(error, save);
          },
        );
      inFlightRef.current = inFlightRef.current.then(() => attempt);
      return attempt;
    },
    [gateway],
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const takePending = useCallback((): PendingViewportSave | null => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    return pending;
  }, []);

  const schedule = useCallback(
    (save: PendingViewportSave) => {
      pendingRef.current = save;
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = takePending();
        if (pending !== null) void write(pending);
      }, delayMs);
    },
    [clearTimer, delayMs, takePending, write],
  );

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    const pending = takePending();
    if (pending !== null) void write(pending);
    await inFlightRef.current;
  }, [clearTimer, takePending, write]);

  const cancel = useCallback(() => {
    clearTimer();
    pendingRef.current = null;
  }, [clearTimer]);

  // Stable identity: callers put this in dependency arrays.
  return useMemo(() => ({ schedule, flush, cancel }), [schedule, flush, cancel]);
}
