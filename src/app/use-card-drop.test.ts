import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { MoveCardsCommand, MoveCardToBoardCommand } from "../commands/card-commands";
import { MoveBoardCommand } from "../commands/board-commands";
import type { IdGenerator } from "../services/id-generator";
import { MutationQueue } from "../persistence/entity-write-queue";
import type {
  BoardPortalDto,
  BoardSummary,
  CardDto,
  MovedBoardReceipt,
  MovedCardReceipt,
  MoveSelectionToBoardReceipt,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import {
  initialState,
  reducer,
  type CurrentBoardAction,
  type CurrentBoardState,
} from "../state/current-board-store";
import { createCardWrites } from "../state/card-writes";
import type { CrossBoardCardSnapshot, CrossBoardDragState } from "../canvas/cross-board-drag";
import type { CrossBoardDragEnd } from "../canvas/use-cross-board-drag";
import type { moveSelectionOntoBoard } from "../canvas/move-selection-onto-board";
import { useCardDrop, type CardDropDeps } from "./use-card-drop";

const mocks = vi.hoisted(() => ({
  moveSelectionOntoBoard: vi.fn(),
}));

vi.mock("../canvas/move-selection-onto-board", () => ({
  moveSelectionOntoBoard: mocks.moveSelectionOntoBoard,
}));

/** Sequential ids ("id-0", "id-1", …), predictable for assertions. */
function idGeneratorFixture(): IdGenerator {
  let counter = 0;
  return { nextId: vi.fn(() => `id-${counter++}`) };
}

function board(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: "home",
    title: "Home",
    parentBoardId: null,
    revision: 1,
    colorToken: "default",
    symbol: null,
    coverAsset: null,
    ...overrides,
  };
}

function note(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 240, height: 120 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc", content: [] },
    plainText: "",
    colorToken: "default",
    ...overrides,
  };
}

function portal(overrides: Partial<BoardPortalDto> = {}): BoardPortalDto {
  return {
    kind: "board_portal",
    id: "portal-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    target: {
      id: "board-A",
      boardRevision: 1,
      title: "Child",
      colorToken: "terracotta",
      symbol: null,
      childBoardCount: 0,
      childCardCount: 0,
      coverAsset: null,
    },
    ...overrides,
  };
}

function movedCardReceipt(overrides: Partial<MovedCardReceipt> = {}): MovedCardReceipt {
  return {
    id: "note-1",
    previousBoardId: "home",
    previousUnsorted: false,
    previousFrame: { x: 0, y: 0, width: 240, height: 120 },
    beforeRevision: 1,
    afterRevision: 2,
    ...overrides,
  };
}

function movedBoardReceipt(overrides: Partial<MovedBoardReceipt> = {}): MovedBoardReceipt {
  return {
    boardId: "board-A",
    portalCardId: "portal-1",
    previousParentBoardId: "home",
    previousPortalFrame: { x: 0, y: 0, width: 120, height: 112 },
    destinationPortalFrame: { x: 0, y: 0, width: 120, height: 112 },
    beforeBoardRevision: 1,
    afterBoardRevision: 2,
    beforePortalRevision: 1,
    afterPortalRevision: 2,
    ...overrides,
  };
}

/** A resolved-but-empty drag end: consumes nothing, matching `takeDragEnd`'s
 *  own "not consumed" shape. Tests override just the fields they need. */
function dragEnd(overrides: Partial<CrossBoardDragEnd> = {}): CrossBoardDragEnd {
  return {
    cardId: null,
    groupIds: [],
    overQuickBoards: false,
    dropTargetBoardId: null,
    crossBoard: null,
    commitCrossBoard: vi.fn(),
    cancelCrossBoard: vi.fn(),
    ...overrides,
  };
}

function cardSnapshot(overrides: Partial<CrossBoardCardSnapshot> = {}): CrossBoardCardSnapshot {
  return {
    cardId: "note-1",
    kind: "note",
    width: 240,
    height: 120,
    label: "Note",
    revision: 1,
    boardId: "home",
    frame: { x: 0, y: 0, width: 240, height: 120 },
    ...overrides,
  };
}

function harness(
  overrides: {
    cards?: CardDto[];
    board?: BoardSummary | null;
    execute?: () => Promise<unknown>;
    readCard?: WorkspaceGateway["readCard"];
    moveSelectionOntoBoard?: (
      ...args: Parameters<typeof moveSelectionOntoBoard>
    ) => ReturnType<typeof moveSelectionOntoBoard>;
    takeDragEnd?: () => CrossBoardDragEnd;
    navigateTo?: CardDropDeps["navigateTo"];
    handleQuickBoardPin?: CardDropDeps["handleQuickBoardPin"];
  } = {},
) {
  const cardsRef: RefObject<CardDto[]> = { current: overrides.cards ?? [] };
  const boardRef: RefObject<BoardSummary | null> = {
    current: overrides.board === undefined ? board() : overrides.board,
  };
  const queueRef: RefObject<MutationQueue> = { current: new MutationQueue() };

  // Typed to accept the command argument (not inferred from the no-arg default
  // implementation) so call-site assertions can destructure `mock.calls[0][0]`.
  const execute = vi.fn<(command: unknown) => Promise<unknown>>(
    overrides.execute ?? (async () => undefined),
  );
  const dispatcher = { execute } as unknown as CommandDispatcher;
  const idGenerator = idGeneratorFixture();
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();

  const readCard = overrides.readCard ?? vi.fn(async () => note());
  const gateway = { readCard } as unknown as WorkspaceGateway;

  mocks.moveSelectionOntoBoard.mockImplementation(
    overrides.moveSelectionOntoBoard ??
      (async (): Promise<MoveSelectionToBoardReceipt> => ({
        operationId: "op-default",
        targetBoardId: "board-unused",
        cards: [],
        boards: [],
      })),
  );

  const navigateTo = overrides.navigateTo ?? vi.fn(async () => undefined);
  const handleQuickBoardPin = overrides.handleQuickBoardPin ?? vi.fn();

  const takeDragEnd = vi.fn(overrides.takeDragEnd ?? (() => dragEnd()));
  const setDragEndResolver = vi.fn();
  const crossBoardDragSession = {
    takeDragEnd,
    setDragEndResolver,
  } as unknown as CardDropDeps["crossBoardDragSession"];

  const deps: CardDropDeps = {
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
    cardWrites: createCardWrites(cardsRef, { current: [] }, dispatch),
    queueRef,
    cardsRef,
    boardRef,
    crossBoardDragSession,
    navigateTo,
    handleQuickBoardPin,
  };

  const { result } = renderHook(() => useCardDrop(deps));

  return {
    result,
    dispatch,
    execute,
    readCard,
    navigateTo,
    handleQuickBoardPin,
    takeDragEnd,
    setDragEndResolver,
    queueRef,
  };
}

describe("useCardDrop", () => {
  beforeEach(() => {
    mocks.moveSelectionOntoBoard.mockReset();
  });

  describe("handleCardsMoved", () => {
    it("builds one MoveCardsCommand with before/after frames and cardsRef revisions, then dispatches cardMoved per card", async () => {
      const a = note({ id: "a", frame: { x: 0, y: 0, width: 240, height: 120 }, revision: 5 });
      const b = note({ id: "b", frame: { x: 10, y: 10, width: 240, height: 120 }, revision: 7 });
      const afterA = { x: 100, y: 100, width: 240, height: 120 };
      const afterB = { x: 200, y: 200, width: 240, height: 120 };
      const test = harness({
        cards: [a, b],
        execute: async () => ({
          cards: [
            { id: "a", revision: 6 },
            { id: "b", revision: 8 },
          ],
        }),
      });

      await act(async () => {
        test.result.current.handleCardsMoved({
          cards: [
            { id: "a", frame: afterA },
            { id: "b", frame: afterB },
          ],
        });
        await test.queueRef.current.flush();
      });

      expect(test.execute).toHaveBeenCalledTimes(1);
      const [command] = test.execute.mock.calls[0];
      expect(command).toBeInstanceOf(MoveCardsCommand);
      expect(command).toMatchObject({
        moves: [
          { id: "a", revision: 5, before: a.frame, after: afterA },
          { id: "b", revision: 7, before: b.frame, after: afterB },
        ],
      });
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMoved", id: "a", revision: 6, frame: afterA });
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMoved", id: "b", revision: 8, frame: afterB });
    });

    it("skips ids not found in cardsRef", async () => {
      const a = note({ id: "a", revision: 5 });
      const test = harness({ cards: [a], execute: async () => ({ cards: [{ id: "a", revision: 6 }] }) });

      await act(async () => {
        test.result.current.handleCardsMoved({
          cards: [
            { id: "a", frame: { x: 1, y: 1, width: 10, height: 10 } },
            { id: "ghost", frame: { x: 2, y: 2, width: 10, height: 10 } },
          ],
        });
        await test.queueRef.current.flush();
      });

      const [command] = test.execute.mock.calls[0];
      expect(command).toMatchObject({ moves: [{ id: "a", revision: 5 }] });
      expect(test.dispatch).toHaveBeenCalledTimes(1);
    });

    it("does nothing when no moved card matches cardsRef", async () => {
      const test = harness({ cards: [] });

      await act(async () => {
        test.result.current.handleCardsMoved({
          cards: [{ id: "ghost", frame: { x: 0, y: 0, width: 1, height: 1 } }],
        });
        await test.queueRef.current.flush();
      });

      expect(test.execute).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a failure when the move command rejects", async () => {
      const a = note({ id: "a" });
      const test = harness({
        cards: [a],
        execute: async () => {
          throw new Error("stale_revision");
        },
      });

      await act(async () => {
        test.result.current.handleCardsMoved({ cards: [{ id: "a", frame: a.frame }] });
        await test.queueRef.current.flush();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" });
    });
  });

  describe("handleCardDroppedOnPortal", () => {
    it("reparents a board_portal via MoveBoardCommand, then removes the portal locally", async () => {
      const p = portal({
        id: "portal-1",
        boardId: "home",
        frame: { x: 5, y: 5, width: 120, height: 112 },
        revision: 2,
        target: { ...portal().target, id: "board-A", boardRevision: 3 },
      });
      const test = harness({ cards: [p] });

      act(() => {
        test.result.current.handleCardDroppedOnPortal("portal-1", "board-B");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["portal-1"] }),
      );
      const [command] = test.execute.mock.calls[0];
      expect(command).toBeInstanceOf(MoveBoardCommand);
      expect(command).toMatchObject({
        boardId: "board-A",
        prevParentBoardId: "home",
        prevFrame: { x: 5, y: 5, width: 120, height: 112 },
        nextParentBoardId: "board-B",
        nextFrame: { x: 40, y: 40, width: 120, height: 112 },
        boardRevision: 3,
        portalRevision: 2,
      });
    });

    it("dispatches a failure when the board move rejects", async () => {
      const p = portal();
      const test = harness({
        cards: [p],
        execute: async () => {
          throw new Error("boom");
        },
      });

      act(() => {
        test.result.current.handleCardDroppedOnPortal(p.id, "board-B");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" }),
      );
    });

    it("routes a leaf card through moveSelectionOntoBoard and shows it in Unsorted when the target is the open board", async () => {
      const n = note({ id: "note-1", revision: 4 });
      const test = harness({
        cards: [n],
        board: board({ id: "board-B" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op-1",
          targetBoardId: "board-B",
          cards: [movedCardReceipt({ id: "note-1", beforeRevision: 4, afterRevision: 5 })],
          boards: [],
        }),
      });

      act(() => {
        test.result.current.handleCardDroppedOnPortal("note-1", "board-B");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMovedToUnsorted", id: "note-1", revision: 5 }),
      );
      expect(mocks.moveSelectionOntoBoard).toHaveBeenCalledWith(
        expect.objectContaining({ targetBoardId: "board-B", leafCards: [n], portals: [] }),
      );
    });

    it("removes the card locally when the leaf lands on a board other than the open one", async () => {
      const n = note({ id: "note-1" });
      const test = harness({
        cards: [n],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op-1",
          targetBoardId: "board-C",
          cards: [movedCardReceipt({ id: "note-1" })],
          boards: [],
        }),
      });

      act(() => {
        test.result.current.handleCardDroppedOnPortal("note-1", "board-C");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["note-1"] }),
      );
    });

    it("does nothing for an unknown card id", () => {
      const test = harness({ cards: [] });

      act(() => {
        test.result.current.handleCardDroppedOnPortal("missing", "board-B");
      });

      expect(test.execute).not.toHaveBeenCalled();
      expect(mocks.moveSelectionOntoBoard).not.toHaveBeenCalled();
    });

    it("dispatches a failure when moveSelectionOntoBoard rejects", async () => {
      const n = note({ id: "note-1" });
      const test = harness({
        cards: [n],
        moveSelectionOntoBoard: async () => {
          throw new Error("stale_revision");
        },
      });

      act(() => {
        test.result.current.handleCardDroppedOnPortal("note-1", "board-B");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" }),
      );
    });
  });

  describe("handleCardsDroppedOnBoard", () => {
    it("splits the selection into leaf cards and portals for moveSelectionOntoBoard", () => {
      const n = note({ id: "note-1" });
      const p = portal({
        id: "portal-1",
        revision: 9,
        target: { ...portal().target, id: "board-A", boardRevision: 3 },
      });
      const test = harness({ cards: [n, p] });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["note-1", "portal-1"], "board-Z");
      });

      expect(mocks.moveSelectionOntoBoard).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBoardId: "board-Z",
          leafCards: [n],
          portals: [{ boardId: "board-A", boardRevision: 3, portalRevision: 9 }],
        }),
      );
    });

    it("dispatches cardMovedToUnsorted per card when the receipt targets the currently open board", async () => {
      const n1 = note({ id: "n1" });
      const n2 = note({ id: "n2" });
      const test = harness({
        cards: [n1, n2],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "home",
          cards: [
            movedCardReceipt({ id: "n1", afterRevision: 2 }),
            movedCardReceipt({ id: "n2", afterRevision: 3 }),
          ],
          boards: [],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["n1", "n2"], "home");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMovedToUnsorted", id: "n2", revision: 3 }),
      );
      expect(test.dispatch).toHaveBeenCalledWith({ type: "cardMovedToUnsorted", id: "n1", revision: 2 });
    });

    it("removes moved cards locally when the receipt targets a different board", async () => {
      const n1 = note({ id: "n1" });
      const test = harness({
        cards: [n1],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "board-Z",
          cards: [movedCardReceipt({ id: "n1" })],
          boards: [],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["n1"], "board-Z");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["n1"] }),
      );
    });

    it("removes a portal that departed the open board", async () => {
      const p = portal({ id: "portal-1" });
      const test = harness({
        cards: [p],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "board-Z",
          cards: [],
          boards: [movedBoardReceipt({ portalCardId: "portal-1", previousParentBoardId: "home" })],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["portal-1"], "board-Z");
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["portal-1"] }),
      );
    });

    it("shows a portal dropped onto the open board's own breadcrumb at its receipt position and revisions", async () => {
      const p = portal({ id: "portal-1", revision: 1, target: { ...portal().target, id: "board-A", boardRevision: 1 } });
      const destination = { x: 40, y: 300, width: 120, height: 112 };
      const test = harness({
        cards: [p],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "home",
          cards: [],
          boards: [
            movedBoardReceipt({
              portalCardId: "portal-1",
              previousParentBoardId: "home",
              destinationPortalFrame: destination,
              afterBoardRevision: 2,
              afterPortalRevision: 2,
            }),
          ],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["portal-1"], "home");
      });
      await waitFor(() => expect(mocks.moveSelectionOntoBoard).toHaveBeenCalledTimes(1));
      await act(async () => {
        await Promise.resolve();
      });

      // Прогоняем все диспатчи через настоящий reducer: важно, что увидит пользователь.
      const state = test.dispatch.mock.calls.reduce<CurrentBoardState>(
        (s, [action]) => reducer(s, action),
        { ...initialState, board: board({ id: "home" }), cards: [p] },
      );
      expect(state.cards).toHaveLength(1);
      expect(state.cards[0]).toMatchObject({
        id: "portal-1",
        revision: 2,
        frame: destination,
        target: { id: "board-A", boardRevision: 2 },
      });
    });

    it("moves leaves into Unsorted and refreshes the portal when a mixed selection is dropped on the open board", async () => {
      const n = note({ id: "n1", revision: 1 });
      const p = portal({ id: "portal-1", revision: 1, target: { ...portal().target, id: "board-A", boardRevision: 1 } });
      const destination = { x: 40, y: 300, width: 120, height: 112 };
      const test = harness({
        cards: [n, p],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "home",
          cards: [movedCardReceipt({ id: "n1", afterRevision: 2 })],
          boards: [
            movedBoardReceipt({
              portalCardId: "portal-1",
              previousParentBoardId: "home",
              destinationPortalFrame: destination,
              afterBoardRevision: 2,
              afterPortalRevision: 2,
            }),
          ],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["n1", "portal-1"], "home");
      });
      await waitFor(() => expect(test.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "portalMoved" })));

      const state = test.dispatch.mock.calls.reduce<CurrentBoardState>(
        (s, [action]) => reducer(s, action),
        { ...initialState, board: board({ id: "home" }), cards: [n, p] },
      );
      expect(state.cards).toEqual([
        { ...p, revision: 2, frame: destination, target: { ...p.target, boardRevision: 2 } },
      ]);
      expect(state.unsortedCards).toEqual([{ ...n, revision: 2 }]);
    });

    it("does not dispatch portalMoved when the selection lands on another board", async () => {
      const p = portal({ id: "portal-1" });
      const test = harness({
        cards: [p],
        board: board({ id: "home" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "board-Z",
          cards: [],
          boards: [movedBoardReceipt({ portalCardId: "portal-1", previousParentBoardId: "home" })],
        }),
      });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard(["portal-1"], "board-Z");
      });
      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["portal-1"] }),
      );
      expect(test.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "portalMoved" }));
    });

    it("does nothing for an empty selection", () => {
      const test = harness({ cards: [] });

      act(() => {
        test.result.current.handleCardsDroppedOnBoard([], "board-Z");
      });

      expect(mocks.moveSelectionOntoBoard).not.toHaveBeenCalled();
    });
  });

  describe("handleCardDragEnd", () => {
    it("moves a cross-board group drop into Unsorted, then commits and navigates", async () => {
      const commitCrossBoard = vi.fn();
      const leaf = cardSnapshot({ cardId: "n1", kind: "note", revision: 4 });
      const portalSnap = cardSnapshot({
        cardId: "p1",
        kind: "board_portal",
        revision: 5,
        targetBoardId: "board-A",
        boardRevision: 2,
      });
      const drag: CrossBoardDragState = {
        cardIds: ["n1", "p1"],
        sourceBoardId: "home",
        hoverBoardId: "board-B",
        pointerBoardId: "board-B",
        phase: "previewing",
        pointer: { x: 100, y: 100 },
        cards: [leaf, portalSnap],
        ghostCard: leaf,
      };
      const test = harness({
        takeDragEnd: () =>
          dragEnd({
            cardId: "n1",
            groupIds: ["n1", "p1"],
            dropTargetBoardId: "board-B",
            crossBoard: { drag, targetBoardId: "board-B", frame: { x: 10, y: 10, width: 240, height: 120 } },
            commitCrossBoard,
          }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "board-B",
          cards: [],
          boards: [],
        }),
      });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(true);
      expect(mocks.moveSelectionOntoBoard).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBoardId: "board-B",
          leafCards: [{ id: "n1", revision: 4 }],
          portals: [{ boardId: "board-A", boardRevision: 2, portalRevision: 5 }],
        }),
      );
      await waitFor(() => expect(commitCrossBoard).toHaveBeenCalledTimes(1));
      expect(test.navigateTo).toHaveBeenCalledWith("board-B", { tabMode: "sync" });
    });

    it("cancels the cross-board drag and dispatches a failure when the group move rejects", async () => {
      const commitCrossBoard = vi.fn();
      const cancelCrossBoard = vi.fn();
      const leaf = cardSnapshot({ cardId: "n1", kind: "note", revision: 4 });
      const other = cardSnapshot({ cardId: "n2", kind: "note", revision: 4 });
      const drag: CrossBoardDragState = {
        cardIds: ["n1", "n2"],
        sourceBoardId: "home",
        hoverBoardId: "board-B",
        pointerBoardId: "board-B",
        phase: "previewing",
        pointer: { x: 0, y: 0 },
        cards: [leaf, other],
        ghostCard: leaf,
      };
      const test = harness({
        takeDragEnd: () =>
          dragEnd({
            cardId: "n1",
            groupIds: ["n1", "n2"],
            dropTargetBoardId: "board-B",
            crossBoard: { drag, targetBoardId: "board-B", frame: { x: 0, y: 0, width: 240, height: 120 } },
            commitCrossBoard,
            cancelCrossBoard,
          }),
        moveSelectionOntoBoard: async () => {
          throw new Error("stale_revision");
        },
      });

      act(() => {
        test.result.current.handleCardDragEnd();
      });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "stale_revision" }),
      );
      expect(cancelCrossBoard).toHaveBeenCalledTimes(1);
      expect(commitCrossBoard).not.toHaveBeenCalled();
    });

    it("reparents a single board-portal cross-board drop via MoveBoardCommand", async () => {
      const commitCrossBoard = vi.fn();
      const gc = cardSnapshot({
        cardId: "p1",
        kind: "board_portal",
        boardId: "home",
        frame: { x: 0, y: 0, width: 120, height: 112 },
        revision: 3,
        targetBoardId: "board-A",
        boardRevision: 7,
      });
      const drag: CrossBoardDragState = {
        cardIds: ["p1"],
        sourceBoardId: "home",
        hoverBoardId: "board-B",
        pointerBoardId: "board-B",
        phase: "previewing",
        pointer: { x: 0, y: 0 },
        cards: [gc],
        ghostCard: gc,
      };
      const test = harness({
        takeDragEnd: () =>
          dragEnd({
            cardId: "p1",
            groupIds: ["p1"],
            dropTargetBoardId: "board-B",
            crossBoard: { drag, targetBoardId: "board-B", frame: { x: 20, y: 30, width: 120, height: 112 } },
            commitCrossBoard,
          }),
      });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(true);
      const [command] = test.execute.mock.calls[0];
      expect(command).toBeInstanceOf(MoveBoardCommand);
      expect(command).toMatchObject({
        boardId: "board-A",
        prevParentBoardId: "home",
        prevFrame: { x: 0, y: 0, width: 120, height: 112 },
        nextParentBoardId: "board-B",
        nextFrame: { x: 20, y: 30, width: 120, height: 112 },
        boardRevision: 7,
        portalRevision: 3,
      });
      await waitFor(() => expect(commitCrossBoard).toHaveBeenCalledTimes(1));
      expect(test.navigateTo).toHaveBeenCalledWith("board-B", { tabMode: "sync" });
    });

    it("reads the fresh revision then moves a single leaf card via MoveCardToBoardCommand", async () => {
      const commitCrossBoard = vi.fn();
      const gc = cardSnapshot({
        cardId: "n1",
        kind: "note",
        boardId: "home",
        frame: { x: 1, y: 2, width: 240, height: 120 },
        revision: 4,
      });
      const drag: CrossBoardDragState = {
        cardIds: ["n1"],
        sourceBoardId: "home",
        hoverBoardId: "board-B",
        pointerBoardId: "board-B",
        phase: "previewing",
        pointer: { x: 0, y: 0 },
        cards: [gc],
        ghostCard: gc,
      };
      const test = harness({
        takeDragEnd: () =>
          dragEnd({
            cardId: "n1",
            groupIds: ["n1"],
            dropTargetBoardId: "board-B",
            crossBoard: { drag, targetBoardId: "board-B", frame: { x: 30, y: 40, width: 240, height: 120 } },
            commitCrossBoard,
          }),
        readCard: vi.fn(async () => note({ id: "n1", revision: 9 })),
      });

      act(() => {
        test.result.current.handleCardDragEnd();
      });

      await waitFor(() => expect(test.execute).toHaveBeenCalledTimes(1));
      expect(test.readCard).toHaveBeenCalledWith("n1");
      const [command] = test.execute.mock.calls[0];
      expect(command).toBeInstanceOf(MoveCardToBoardCommand);
      expect(command).toMatchObject({
        cardId: "n1",
        sourceBoardId: "home",
        sourceFrame: { x: 1, y: 2, width: 240, height: 120 },
        currentRevision: 9,
        targetBoardId: "board-B",
        targetFrame: { x: 30, y: 40, width: 240, height: 120 },
      });
      await waitFor(() => expect(commitCrossBoard).toHaveBeenCalledTimes(1));
      expect(test.navigateTo).toHaveBeenCalledWith("board-B", { tabMode: "sync" });
    });

    it("pins a board portal dragged over Quick Boards and returns true", () => {
      const p = portal({ id: "portal-1", target: { ...portal().target, id: "board-A" } });
      const test = harness({
        cards: [p],
        takeDragEnd: () => dragEnd({ cardId: "portal-1", overQuickBoards: true }),
      });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(true);
      expect(test.handleQuickBoardPin).toHaveBeenCalledWith("board-A");
    });

    it("returns false for a leaf card dragged over Quick Boards with no board target", () => {
      const n = note({ id: "note-1" });
      const test = harness({
        cards: [n],
        takeDragEnd: () => dragEnd({ cardId: "note-1", overQuickBoards: true, dropTargetBoardId: null }),
      });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(false);
      expect(test.handleQuickBoardPin).not.toHaveBeenCalled();
    });

    it("delegates a plain board-target drop to handleCardsDroppedOnBoard and returns true", async () => {
      const n = note({ id: "note-1", revision: 4 });
      const test = harness({
        cards: [n],
        board: board({ id: "home" }),
        takeDragEnd: () => dragEnd({ cardId: "note-1", dropTargetBoardId: "board-Z" }),
        moveSelectionOntoBoard: async () => ({
          operationId: "op",
          targetBoardId: "board-Z",
          cards: [movedCardReceipt({ id: "note-1" })],
          boards: [],
        }),
      });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(true);
      expect(mocks.moveSelectionOntoBoard).toHaveBeenCalledWith(
        expect.objectContaining({ targetBoardId: "board-Z", leafCards: [n] }),
      );
      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith({ type: "cardsRemoved", ids: ["note-1"] }),
      );
    });

    it("returns false when nothing resolves", () => {
      const test = harness({ takeDragEnd: () => dragEnd() });

      let consumed: boolean | undefined;
      act(() => {
        consumed = test.result.current.handleCardDragEnd();
      });

      expect(consumed).toBe(false);
      expect(test.handleQuickBoardPin).not.toHaveBeenCalled();
      expect(mocks.moveSelectionOntoBoard).not.toHaveBeenCalled();
    });
  });

  describe("drag-end resolver registration", () => {
    it("registers handleCardDragEnd with the cross-board drag session on mount", () => {
      const test = harness();

      expect(test.setDragEndResolver).toHaveBeenCalledTimes(1);
      expect(test.setDragEndResolver).toHaveBeenCalledWith(test.result.current.handleCardDragEnd);
    });
  });
});
