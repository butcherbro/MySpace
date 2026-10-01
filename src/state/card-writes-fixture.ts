import type { Dispatch, RefObject } from "react";
import type { CardDto } from "../services/workspace-gateway";
import { createCardWrites, type CardWrites } from "./card-writes";
import type { CurrentBoardAction } from "./current-board-store";

/**
 * Test helper: a ledger that has already loaded board `boardId`, so it accepts
 * that board's `cardAdded`. The load itself is not passed on to `dispatch`.
 */
export function loadedCardWrites(
  cardsRef: RefObject<CardDto[]>,
  dispatch: Dispatch<CurrentBoardAction>,
  boardId = "home",
): CardWrites {
  let forward: Dispatch<CurrentBoardAction> = () => {};
  const writes = createCardWrites(cardsRef, { current: [] }, (action) => forward(action));
  writes.applySnapshot(
    {
      board: { id: boardId, title: boardId, parentBoardId: null, revision: 1, colorToken: "ink", symbol: null, coverAsset: null },
      breadcrumbs: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportRevision: 1,
      cards: cardsRef.current,
      unsortedCards: [],
    },
    0,
  );
  forward = dispatch;
  return writes;
}
