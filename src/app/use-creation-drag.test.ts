import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardSummary, CardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useCreationDrag, type CreationDragDeps } from "./use-creation-drag";

function board(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: "board-1",
    title: "Board",
    parentBoardId: null,
    revision: 1,
    colorToken: "default",
    symbol: null,
    coverAsset: null,
    ...overrides,
  };
}

function card(overrides: Partial<CardDto> = {}): CardDto {
  return {
    kind: "note",
    id: "card-1",
    boardId: "board-1",
    frame: { x: 0, y: 0, width: 200, height: 100 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc", content: [] },
    plainText: "",
    colorToken: "default",
    ...overrides,
  } as CardDto;
}

/** Fakes `document.elementFromPoint`: over the canvas or over nothing. */
function fakeElementAt(overCanvas: boolean): Element | null {
  if (!overCanvas) return null;
  return {
    closest: (selector: string) => (selector === '[data-testid="canvas"]' ? {} : null),
  } as unknown as Element;
}

function harness(
  overrides: {
    board?: BoardSummary | null;
    unsortedCards?: CardDto[];
    cards?: CardDto[];
    placeUnsortedCard?: ReturnType<typeof vi.fn>;
    screenToFlow?: ((x: number, y: number) => { x: number; y: number }) | null;
  } = {},
) {
  const currentBoard = overrides.board === undefined ? board() : overrides.board;
  const placeUnsortedCard =
    overrides.placeUnsortedCard ?? vi.fn(async () => ({ id: "card-1", revision: 2 }));
  const gateway = { placeUnsortedCard } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null> = {
    current: overrides.screenToFlow === undefined ? null : overrides.screenToFlow,
  };
  const handleCreateNote = vi.fn();
  const handleCreateLink = vi.fn();
  const handleCreateChildBoard = vi.fn();

  const deps: CreationDragDeps = {
    unsortedCards: overrides.unsortedCards ?? [card()],
    cards: overrides.cards ?? [],
    board: currentBoard,
    gateway,
    dispatch,
    screenToFlowRef,
    handleCreateNote,
    handleCreateLink,
    handleCreateChildBoard,
  };

  const { result } = renderHook(() => useCreationDrag(deps));

  return { result, dispatch, placeUnsortedCard, handleCreateNote, handleCreateLink, handleCreateChildBoard };
}

/** The `move`/`up` listener registered for `eventName` on the given spy. */
function listenerFor(spy: ReturnType<typeof vi.spyOn>, eventName: string): (e: unknown) => void {
  const call = spy.mock.calls.find(([name]: [string, unknown]) => name === eventName);
  if (!call) throw new Error(`no listener registered for ${eventName}`);
  return call[1] as (e: unknown) => void;
}

describe("useCreationDrag", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;
  let elementFromPointSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
    elementFromPointSpy = vi.spyOn(document, "elementFromPoint");
  });

  // vi.spyOn reuses an existing spy on the same method instead of stacking a
  // new one, so a spy from a previous test (and its accumulated mock.calls)
  // would otherwise leak into this one — restore before the next `beforeEach`.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handlePlaceUnsortedCard", () => {
    it("places the card below the lowest existing card and dispatches unsortedCardPlaced", async () => {
      const test = harness({
        unsortedCards: [card({ id: "u1", revision: 5, frame: { x: 0, y: 0, width: 200, height: 100 } })],
        cards: [card({ id: "c1", frame: { x: 0, y: 100, width: 50, height: 50 } })],
      });

      await act(async () => {
        test.result.current.handlePlaceUnsortedCard("u1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.placeUnsortedCard).toHaveBeenCalledWith({
        id: "u1",
        expectedRevision: 5,
        frame: { x: 40, y: 174, width: 200, height: 100 },
      });
      expect(test.dispatch).toHaveBeenCalledWith({
        type: "unsortedCardPlaced",
        id: "u1",
        frame: { x: 40, y: 174, width: 200, height: 100 },
        revision: 2,
      });
    });

    it("falls back to y=40 when the board is otherwise empty", async () => {
      const test = harness({ unsortedCards: [card({ id: "u1" })], cards: [] });

      await act(async () => {
        test.result.current.handlePlaceUnsortedCard("u1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.placeUnsortedCard).toHaveBeenCalledWith(
        expect.objectContaining({ frame: expect.objectContaining({ x: 40, y: 40 }) }),
      );
    });

    it("does nothing for an unknown card id or a missing board", async () => {
      const test = harness({ board: null });

      test.result.current.handlePlaceUnsortedCard("does-not-exist");

      expect(test.placeUnsortedCard).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the gateway call rejects", async () => {
      const test = harness({
        unsortedCards: [card({ id: "u1" })],
        placeUnsortedCard: vi.fn(async () => { throw new Error("stale_revision"); }),
      });

      await act(async () => {
        test.result.current.handlePlaceUnsortedCard("u1");
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleUnsortedPointerDown", () => {
    it("shows a ghost at the pointer and registers window listeners", () => {
      const test = harness();

      act(() => {
        test.result.current.handleUnsortedPointerDown("card-1", 10, 20);
      });

      expect(test.result.current.unsortedGhost).toEqual({ cardId: "card-1", x: 10, y: 20 });
      expect(addSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    });

    it("move updates the ghost position", () => {
      const test = harness();
      act(() => {
        test.result.current.handleUnsortedPointerDown("card-1", 10, 20);
      });
      const move = listenerFor(addSpy, "pointermove");

      act(() => {
        move({ clientX: 30, clientY: 40 });
      });

      expect(test.result.current.unsortedGhost).toEqual({ cardId: "card-1", x: 30, y: 40 });
    });

    it("up over the canvas places the card at the flow position and cleans up both listeners", async () => {
      elementFromPointSpy.mockReturnValue(fakeElementAt(true));
      const flow = vi.fn((x: number, y: number) => ({ x: x + 1000, y: y + 2000 }));
      const test = harness({
        unsortedCards: [card({ id: "card-1", revision: 3, frame: { x: 0, y: 0, width: 200, height: 100 } })],
        screenToFlow: flow,
      });
      act(() => {
        test.result.current.handleUnsortedPointerDown("card-1", 10, 20);
      });
      const up = listenerFor(addSpy, "pointerup");

      await act(async () => {
        up({ clientX: 50, clientY: 60 });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(flow).toHaveBeenCalledWith(50, 60);
      expect(test.placeUnsortedCard).toHaveBeenCalledWith({
        id: "card-1",
        expectedRevision: 3,
        // flow(50, 60) = {1050, 2060}, minus half the card's frame (100, 50).
        frame: { x: 950, y: 2010, width: 200, height: 100 },
      });
      expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
      expect(test.result.current.unsortedGhost).toBeNull();
    });

    it("up off the canvas cleans up without placing the card", () => {
      elementFromPointSpy.mockReturnValue(fakeElementAt(false));
      const test = harness();
      act(() => {
        test.result.current.handleUnsortedPointerDown("card-1", 10, 20);
      });
      const up = listenerFor(addSpy, "pointerup");

      act(() => {
        up({ clientX: 999, clientY: 999 });
      });

      expect(test.placeUnsortedCard).not.toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    });
  });

  describe("handleCreationDragStart", () => {
    it("shows a create ghost and registers window listeners", () => {
      const test = harness();

      act(() => {
        test.result.current.handleCreationDragStart("note", 10, 20);
      });

      expect(test.result.current.createGhost).toEqual({ x: 10, y: 20, kind: "note" });
      expect(addSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    });

    it("move updates the create ghost position", () => {
      const test = harness();
      act(() => {
        test.result.current.handleCreationDragStart("link", 10, 20);
      });
      const move = listenerFor(addSpy, "pointermove");

      act(() => {
        move({ clientX: 30, clientY: 40 });
      });

      expect(test.result.current.createGhost).toEqual({ x: 30, y: 40, kind: "link" });
    });

    it("a drag released over the canvas creates the tool at the drop point and cleans up", () => {
      elementFromPointSpy.mockReturnValue(fakeElementAt(true));
      const flow = vi.fn(() => ({ x: 300, y: 200 }));
      const test = harness({ screenToFlow: flow });
      act(() => {
        test.result.current.handleCreationDragStart("board", 10, 20);
      });
      const move = listenerFor(addSpy, "pointermove");
      const up = listenerFor(addSpy, "pointerup");

      act(() => {
        move({ clientX: 15, clientY: 25 });
        up({ clientX: 400, clientY: 300 });
      });

      expect(test.handleCreateChildBoard).toHaveBeenCalledWith({ x: 240, y: 144 });
      expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
      expect(test.result.current.createGhost).toBeNull();
    });

    it("a plain click (no move) off the canvas falls back to the default placement", () => {
      elementFromPointSpy.mockReturnValue(fakeElementAt(false));
      const test = harness();
      act(() => {
        test.result.current.handleCreationDragStart("note", 10, 20);
      });
      const up = listenerFor(addSpy, "pointerup");

      act(() => {
        up({ clientX: 10, clientY: 20 });
      });

      expect(test.handleCreateNote).toHaveBeenCalledWith();
    });

    it("a real drag (moved) released off the canvas creates nothing", () => {
      elementFromPointSpy.mockReturnValue(fakeElementAt(false));
      const test = harness();
      act(() => {
        test.result.current.handleCreationDragStart("note", 10, 20);
      });
      const move = listenerFor(addSpy, "pointermove");
      const up = listenerFor(addSpy, "pointerup");

      act(() => {
        move({ clientX: 50, clientY: 60 });
        up({ clientX: 999, clientY: 999 });
      });

      expect(test.handleCreateNote).not.toHaveBeenCalled();
      expect(test.handleCreateLink).not.toHaveBeenCalled();
      expect(test.handleCreateChildBoard).not.toHaveBeenCalled();
    });
  });
});
