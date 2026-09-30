import type { Dispatch, RefObject } from "react";
import type { BoardSummary, CardDto } from "../services/workspace-gateway";
import {
  initialState,
  reducer,
  type CurrentBoardAction,
  type CurrentBoardState,
  type SnapshotRequestChanges,
} from "./current-board-store";

/** Store actions that change the open board's cards locally. */
export type CardWriteAction = Extract<
  CurrentBoardAction,
  {
    type:
      | "cardAdded"
      | "cardsRemoved"
      | "cardContentUpdated"
      | "imageCaptionUpdated"
      | "embedDescriptionUpdated"
      | "cardReplaced"
      | "cardMoved"
      | "portalMoved"
      | "cardMovedToUnsorted"
      | "unsortedCardPlaced";
  }
>;

/** A loaded board snapshot, before the local changes are merged in. */
export type LoadedSnapshot = Omit<
  Extract<CurrentBoardAction, { type: "snapshotLoaded" }>,
  "type" | "sinceRequest"
>;

/**
 * The one way to change the open board's cards and to apply its snapshot.
 * `cardsRef`/`unsortedCardsRef` and the store move in the same step, so a
 * queued write never reads a revision the store has already moved past; and
 * every local change is stamped, so a same-board snapshot requested before it
 * does not undo it.
 */
export interface CardWrites {
  apply: (action: CardWriteAction) => void;
  /** Stamp for a snapshot request; hand it back to `applySnapshot`. */
  snapshotRequested: () => number;
  applySnapshot: (snapshot: LoadedSnapshot, requestStamp: number) => void;
}

type Change = { at: number; kind: "write" | "remove" };

export function createCardWrites(
  cardsRef: RefObject<CardDto[]>,
  unsortedCardsRef: RefObject<CardDto[]>,
  dispatch: Dispatch<CurrentBoardAction>,
): CardWrites {
  let seq = 0;
  let board: BoardSummary | null = null;
  const lastChange = new Map<string, Change>();
  const addedAt = new Map<string, number>();

  // Тот же reducer, что и у store: ref и state не могут разойтись в правилах.
  const run = (action: CurrentBoardAction): CurrentBoardState => {
    const next = reducer(
      { ...initialState, board, cards: cardsRef.current, unsortedCards: unsortedCardsRef.current },
      action,
    );
    cardsRef.current = next.cards;
    unsortedCardsRef.current = next.unsortedCards;
    return next;
  };

  const held = (state: Pick<CurrentBoardState, "cards" | "unsortedCards">, id: string) =>
    state.cards.find((c) => c.id === id) ?? state.unsortedCards.find((c) => c.id === id);

  const changesSince = (stamp: number): SnapshotRequestChanges => {
    const since: SnapshotRequestChanges = { written: [], added: [], removed: [] };
    for (const [id, change] of lastChange) {
      if (change.at > stamp) (change.kind === "remove" ? since.removed : since.written).push(id);
    }
    for (const [id, at] of addedAt) {
      if (at > stamp && lastChange.get(id)?.kind !== "remove") since.added.push(id);
    }
    return since;
  };

  return {
    apply(action) {
      const before = { cards: cardsRef.current, unsortedCards: unsortedCardsRef.current };
      const next = run(action);
      const at = ++seq;
      if (action.type === "cardAdded") {
        lastChange.set(action.card.id, { at, kind: "write" });
        addedAt.set(action.card.id, at);
      } else if (action.type === "cardsRemoved") {
        for (const id of action.ids) lastChange.set(id, { at, kind: "remove" });
      } else if (held(before, action.id) !== held(next, action.id)) {
        // Штампуем только ответ, который действительно изменил карточку:
        // отброшенный как устаревший не даёт своей копии права на снимок.
        lastChange.set(action.id, { at, kind: "write" });
      }
      dispatch(action);
    },
    snapshotRequested() {
      return seq;
    },
    applySnapshot(snapshot, requestStamp) {
      if (board?.id !== snapshot.board.id) {
        // Штампы привязаны к открытой доске; при переходе они больше не нужны.
        lastChange.clear();
        addedAt.clear();
      }
      const action: CurrentBoardAction = {
        type: "snapshotLoaded",
        ...snapshot,
        sinceRequest: changesSince(requestStamp),
      };
      run(action);
      board = snapshot.board;
      dispatch(action);
    },
  };
}
