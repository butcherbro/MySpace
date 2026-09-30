import { describe, expect, it, vi } from "vitest";
import type { BoardSummary, CardDto, NoteCardDto } from "../services/workspace-gateway";
import { createCardWrites, type LoadedSnapshot } from "./card-writes";
import type { CurrentBoardAction } from "./current-board-store";

function note(id: string, revision: number): NoteCardDto {
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision,
    documentJson: { type: "doc" },
    plainText: "",
    colorToken: "default",
  };
}

function board(id: string): BoardSummary {
  return { id, title: id, parentBoardId: null, revision: 1, colorToken: "ink", symbol: null, coverAsset: null };
}

function loaded(boardId: string, cards: CardDto[], unsortedCards: CardDto[] = []): LoadedSnapshot {
  return {
    board: board(boardId),
    breadcrumbs: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportRevision: 1,
    cards,
    unsortedCards,
  };
}

function harness(cards: CardDto[] = [], unsortedCards: CardDto[] = []) {
  const cardsRef = { current: cards };
  const unsortedCardsRef = { current: unsortedCards };
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const writes = createCardWrites(cardsRef, unsortedCardsRef, dispatch);
  return { cardsRef, unsortedCardsRef, dispatch, writes };
}

/** The `sinceRequest` of the last dispatched snapshot. */
function sinceRequest(dispatch: ReturnType<typeof harness>["dispatch"]) {
  const last = dispatch.mock.calls[dispatch.mock.calls.length - 1]?.[0];
  return last?.type === "snapshotLoaded" ? last.sinceRequest : undefined;
}

describe("createCardWrites", () => {
  const frame = { x: 5, y: 6, width: 200, height: 80 };

  it("updates cardsRef by the store's rules and dispatches the same action", () => {
    const test = harness([note("a", 6)]);

    test.writes.apply({ type: "cardMoved", id: "a", revision: 7, frame });
    expect(test.cardsRef.current[0]).toMatchObject({ revision: 7, frame });
    expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMoved", id: "a", revision: 7, frame });

    // Устаревший ответ ref не откатывает — ровно как reducer.
    test.writes.apply({ type: "cardMoved", id: "a", revision: 5, frame: { ...frame, x: 0 } });
    expect(test.cardsRef.current[0]).toMatchObject({ revision: 7, frame });
  });

  it("puts a card placed out of Unsorted into cardsRef at once", () => {
    const test = harness([], [note("u", 3)]);

    test.writes.apply({ type: "unsortedCardPlaced", id: "u", revision: 4, frame });

    expect(test.cardsRef.current).toEqual([{ ...note("u", 3), revision: 4, frame }]);
    expect(test.unsortedCardsRef.current).toEqual([]);
  });

  it("reports writes, additions and removals made after the snapshot request", () => {
    const test = harness([note("a", 1), note("b", 1), note("c", 1)]);
    test.writes.applySnapshot(loaded("home", test.cardsRef.current), test.writes.snapshotRequested());
    test.writes.apply({ type: "cardMoved", id: "a", revision: 2, frame });

    const stamp = test.writes.snapshotRequested();
    test.writes.apply({ type: "cardMoved", id: "b", revision: 2, frame });
    test.writes.apply({ type: "cardAdded", card: note("n", 1) });
    test.writes.apply({ type: "cardsRemoved", ids: ["c"] });
    test.writes.applySnapshot(loaded("home", [note("a", 2), note("b", 1), note("c", 1)]), stamp);

    expect(sinceRequest(test.dispatch)).toEqual({ written: ["b", "n"], added: ["n"], removed: ["c"] });
  });

  it("does not stamp an answer the store dropped as stale", () => {
    const test = harness([note("a", 6)]);
    test.writes.applySnapshot(loaded("home", test.cardsRef.current), test.writes.snapshotRequested());

    const stamp = test.writes.snapshotRequested();
    test.writes.apply({ type: "cardMoved", id: "a", revision: 5, frame });
    test.writes.apply({ type: "cardReplaced", id: "a", card: note("a", 4) });
    test.writes.applySnapshot(loaded("home", [note("a", 6)]), stamp);

    expect(sinceRequest(test.dispatch)).toEqual({ written: [], added: [], removed: [] });
  });

  it("brings cardsRef to the merged snapshot in the same step as the dispatch", () => {
    const test = harness([note("a", 1), note("b", 1)]);
    test.writes.applySnapshot(loaded("home", test.cardsRef.current), test.writes.snapshotRequested());
    const stamp = test.writes.snapshotRequested();
    test.writes.apply({ type: "cardMoved", id: "a", revision: 3, frame });

    // Снимок прочитан до ответа по "a", но уже видит внешнюю запись "b".
    test.writes.applySnapshot(loaded("home", [note("a", 2), note("b", 5)]), stamp);

    expect(test.cardsRef.current).toEqual([{ ...note("a", 3), frame }, note("b", 5)]);
  });

  it("forgets the stamps when another board is opened", () => {
    const test = harness([note("a", 1)]);
    test.writes.applySnapshot(loaded("home", test.cardsRef.current), test.writes.snapshotRequested());
    test.writes.apply({ type: "cardMoved", id: "a", revision: 2, frame });

    test.writes.applySnapshot(loaded("other", []), test.writes.snapshotRequested());
    // Перезагрузка той же доски со штампом «с самого начала»: старые записи уже забыты.
    test.writes.applySnapshot(loaded("other", []), 0);

    expect(sinceRequest(test.dispatch)).toEqual({ written: [], added: [], removed: [] });
  });
});
