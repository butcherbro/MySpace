import { useCallback, useEffect, type Dispatch, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import { normalizeDocument } from "../editor/document-codec";
import { flushAllDrafts } from "../editor/draft-flush-registry";
import { useBoardNavigation, type BoardNavigation } from "../navigation/use-board-navigation";
import type { MutationQueue } from "../persistence/entity-write-queue";
import type { BoardSnapshot, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";
import type { useViewportController } from "../state/use-viewport-controller";

/**
 * Board loading: applying a loaded snapshot to the store, the navigation spine
 * (tabs, history, latest-wins loads) and the initial load of the home board.
 * Pending writes (drafts, the mutation queue, the viewport) are drained before
 * a navigation replaces the projection.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 11).
 */

export interface BoardLoadingDeps {
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
  /** Tells a same-board reload which cards were written after it was requested. */
  cardWrites: CardWrites;
  queueRef: RefObject<MutationQueue>;
  viewportController: ReturnType<typeof useViewportController>;
}

export function useBoardLoading(deps: BoardLoadingDeps): BoardNavigation {
  const { gateway, dispatch, cardWrites, queueRef, viewportController } = deps;

  // Applying a loaded snapshot is the store's concern, not navigation's: note
  // documents are normalized here, and both the startup load and every later
  // navigation go through this one place.
  const applySnapshot = useCallback(
    (snapshot: BoardSnapshot, requestStamp: number) => {
      // Через cardWrites: cardsRef получает слитые карточки в том же шаге, что и store.
      cardWrites.applySnapshot(
        {
          board: snapshot.board,
          breadcrumbs: snapshot.breadcrumbs,
          viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
          viewportRevision: snapshot.viewport.revision,
          cards: snapshot.cards.map((c) =>
            c.kind === "note"
              ? { ...c, documentJson: normalizeDocument(c.documentJson) }
              : c,
          ),
          unsortedCards: snapshot.unsortedCards.map((c) =>
            c.kind === "note"
              ? { ...c, documentJson: normalizeDocument(c.documentJson) }
              : c,
          ),
        },
        requestStamp,
      );
    },
    [cardWrites],
  );

  // The navigation spine: snapshot loading, open-board tabs, back/forward
  // history, and the latest-wins guard that keeps a slow load from overwriting a
  // newer navigation. Pending writes are drained through the queue and viewport
  // barriers before the projection is replaced.
  const navigation = useBoardNavigation({
    gateway,
    drainPendingWrites: useCallback(async () => {
      // The editing card's own draft (still inside its 250ms debounce) must
      // land in the mutation queue before the queue is flushed, or navigation
      // would replace the projection while that write is still in flight —
      // see draft-flush-registry.ts.
      await flushAllDrafts();
      await queueRef.current.flush();
      await viewportController.flush();
    }, [viewportController, queueRef]),
    stampSnapshotRequest: cardWrites.snapshotRequested,
    onSnapshotLoaded: applySnapshot,
  });
  const initializeNavigation = navigation.initialize;

  // Initial board load. Lives after the navigation controller because it seeds
  // the tabs and history through it.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      dispatch({ type: "loading" });
      try {
        const home = await gateway.getHomeBoard();
        const requestStamp = cardWrites.snapshotRequested();
        const snapshot = await gateway.loadBoardSnapshot(home.id);
        if (cancelled) return;
        initializeNavigation(snapshot);
        applySnapshot(snapshot, requestStamp);
      } catch (e) {
        if (!cancelled) {
          dispatch({ type: "failed", message: errorMessage(e) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, gateway, initializeNavigation, dispatch, cardWrites]);

  return navigation;
}
