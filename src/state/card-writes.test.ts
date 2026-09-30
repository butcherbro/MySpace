import { act, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useLayoutEffect, useReducer, type Dispatch } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BoardSummary, CardDto, NoteCardDto } from "../services/workspace-gateway";
import { createCardWrites, useCardWrites, type LoadedSnapshot } from "./card-writes";
import { initialState, reducer, type BoardViewAction, type CurrentBoardAction } from "./current-board-store";

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

  it("ignores a late cardAdded for the board that was open before", () => {
    const test = harness();
    test.writes.applySnapshot(loaded("board-b", []), test.writes.snapshotRequested());
    test.dispatch.mockClear();

    // «New note» нажали на доске A, ответ пришёл, когда уже открыта B.
    test.writes.apply({ type: "cardAdded", card: { ...note("late", 1), boardId: "board-a" } });

    expect(test.cardsRef.current).toEqual([]);
    expect(test.dispatch).not.toHaveBeenCalled();
  });

  it("brings changes without a revision (colour, cover, shortcut) into the refs at once", () => {
    const portal = {
      kind: "board_portal",
      id: "p",
      boardId: "home",
      frame,
      zIndex: 0,
      revision: 1,
      target: { id: "child", boardRevision: 1, coverAsset: null },
    } as unknown as CardDto;
    const test = harness([note("a", 1), portal]);
    const cover = { id: "asset-1" } as unknown as NonNullable<Extract<CardDto, { kind: "board_portal" }>["target"]["coverAsset"]>;

    test.writes.apply({ type: "noteColorChanged", id: "a", colorToken: "sun" });
    test.writes.apply({ type: "boardCoverChanged", boardId: "child", coverAsset: cover });

    expect(test.cardsRef.current[0]).toMatchObject({ colorToken: "sun" });
    expect(test.cardsRef.current[1]).toMatchObject({ target: { coverAsset: cover } });
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

describe("useCardWrites", () => {
  const frame = { x: 5, y: 6, width: 200, height: 80 };

  it("keeps cardsRef ahead of a commit whose effects run after a newer apply", async () => {
    // Вне act: React рендерит и коммитит в одной задаче, а пассивные эффекты
    // выполняет в следующей — между ними успевает микрозадача с новой записью.
    const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    const seen: Array<{ state: number; ref: number }> = [];
    const { result } = renderHook(() => {
      const [state, dispatch] = useReducer(reducer, initialState);
      const { cardsRef, cardWrites } = useCardWrites(dispatch);
      const revision = state.cards[0]?.revision ?? 0;
      useLayoutEffect(() => {
        // Ответ следующей записи приходит сразу после коммита первой.
        if (revision === 2) {
          queueMicrotask(() => cardWrites.apply({ type: "cardMoved", id: "a", revision: 3, frame }));
        }
      }, [revision, cardWrites]);
      useEffect(() => {
        seen.push({ state: revision, ref: cardsRef.current[0]?.revision ?? 0 });
      });
      return cardWrites;
    });
    act(() => result.current.applySnapshot(loaded("home", [note("a", 1)]), 0));

    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      result.current.apply({ type: "cardMoved", id: "a", revision: 2, frame });
      await waitFor(() => expect(seen.some((s) => s.state === 3)).toBe(true));
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }

    // Эффекты коммита с ревизией 2 уже видят ответ с ревизией 3 в ref.
    expect(seen.filter((s) => s.state === 2).map((s) => s.ref)).toEqual([3]);
  });
});

describe("single writer", () => {
  it("does not let a hook dispatch a card change or a snapshot directly (checked by tsc)", () => {
    const dispatched: BoardViewAction[] = [];
    const dispatch: Dispatch<BoardViewAction> = (action) => dispatched.push(action);
    const frame = { x: 0, y: 0, width: 1, height: 1 };

    // @ts-expect-error — card changes go through CardWrites, never a hook's dispatch
    dispatch({ type: "cardMoved", id: "a", revision: 2, frame });
    // @ts-expect-error — so does the snapshot
    dispatch({ type: "snapshotLoaded", ...loaded("home", []) });
    dispatch({ type: "selectionChanged", ids: ["a"] });

    expect(dispatched).toHaveLength(3);
  });
});
