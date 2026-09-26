import { useCallback, useEffect, useRef } from "react";
import type { CanvasViewport } from "../canvas/canvas-types";
import type { WorkspaceGateway } from "../services/workspace-gateway";
import { useViewportPersistence } from "./use-viewport-persistence";

/**
 * Viewport controller: the canvas viewport as the board's persisted state.
 *
 * The debounce and the "write exactly the record captured when the viewport
 * settled" rule live in `useViewportPersistence`. What this hook owns is the
 * board-scoped policy around it: the board is pinned to its top-left origin (a
 * pan is never persisted, only the zoom), every save carries the revision that
 * was current when the viewport settled, and a save that lands after the user
 * moved to another board is dropped rather than surfaced on the new board.
 *
 * Extracted from `App.tsx` unchanged (Task 17, extraction 2 of 6).
 */

export interface ViewportControllerOptions {
  gateway: WorkspaceGateway;
  /** The open board, or `null` while none is loaded. */
  boardId: string | null;
  /** The board's stored viewport revision. */
  revision: number;
  /** The settled viewport the canvas should adopt. */
  onSettled: (viewport: CanvasViewport) => void;
  /** The revision the stored viewport now has, after a successful save. */
  onSaved: (revision: number) => void;
  /** A failed save that belongs to the still-open board. */
  onError: (message: string) => void;
  delayMs?: number;
}

export interface ViewportController {
  handleViewportChanged: (event: { viewport: CanvasViewport }) => void;
  /** Writes a pending viewport now: the navigation and close barrier. */
  flush: () => Promise<void>;
}

export function useViewportController(options: ViewportControllerOptions): ViewportController {
  const { gateway, boardId, revision, onSettled, onSaved, onError, delayMs } = options;

  // The revision is read when the viewport settles, which is exactly what the
  // pending record must carry.
  const revisionRef = useRef(revision);
  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  const persistence = useViewportPersistence(gateway, {
    delayMs,
    onSaved: (save, revision) => {
      if (boardId !== save.boardId) return;
      onSaved(revision);
    },
    onError: (error, save) => {
      // A rejection belongs to the board that scheduled it; surfacing it on the
      // board the user has since opened is the stale-revision banner bug.
      if (boardId !== save.boardId) return;
      onError(error instanceof Error ? error.message : String(error));
    },
  });

  const handleViewportChanged = useCallback(
    (event: { viewport: CanvasViewport }) => {
      // The board is pinned to its top-left origin; position is never persisted
      // (see the reducer's snapshotLoaded reset), only zoom is remembered.
      const settled: CanvasViewport = {
        x: 0,
        y: 0,
        zoom: event.viewport.zoom,
      };
      onSettled(settled);
      if (boardId === null) return;
      persistence.schedule({
        boardId,
        revision: revisionRef.current,
        viewport: settled,
      });
    },
    [boardId, onSettled, persistence],
  );

  const flush = useCallback(() => persistence.flush(), [persistence]);

  return { handleViewportChanged, flush };
}
