import { act, renderHook, waitFor } from "@testing-library/react";
import type { Dispatch, RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardNavigation } from "../navigation/use-board-navigation";
import type { MutationQueue } from "../persistence/entity-write-queue";
import type {
  BoardPortalDto,
  BoardSnapshot,
  BoardSummary,
  CardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { createCardWrites } from "../state/card-writes";
import type { useViewportController } from "../state/use-viewport-controller";
import { useBoardLoading, type BoardLoadingDeps } from "./use-board-loading";

const mocks = vi.hoisted(() => ({
  useBoardNavigation: vi.fn(),
  flushAllDrafts: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("../navigation/use-board-navigation", () => ({
  useBoardNavigation: mocks.useBoardNavigation,
}));

vi.mock("../editor/draft-flush-registry", () => ({
  flushAllDrafts: mocks.flushAllDrafts,
}));

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

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    board: board(),
    breadcrumbs: [],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: [],
    unsortedCards: [],
    ...overrides,
  };
}

/** A stand-in `BoardNavigation` returned by the mocked `useBoardNavigation`. */
function navigationStub(): BoardNavigation {
  return {
    tabs: null,
    initialize: vi.fn(),
    navigateTo: vi.fn(async () => undefined),
    goBack: vi.fn(),
    goForward: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    reorderTabs: vi.fn(),
  };
}

function harness(
  overrides: {
    getHomeBoard?: WorkspaceGateway["getHomeBoard"];
    loadBoardSnapshot?: WorkspaceGateway["loadBoardSnapshot"];
    queueFlush?: () => Promise<void>;
    viewportFlush?: () => Promise<void>;
  } = {},
) {
  const dispatch = vi.fn<Dispatch<CurrentBoardAction>>();
  const getHomeBoard = overrides.getHomeBoard ?? vi.fn(async () => board());
  const loadBoardSnapshot = overrides.loadBoardSnapshot ?? vi.fn(async () => snapshot());
  const gateway = { getHomeBoard, loadBoardSnapshot } as unknown as WorkspaceGateway;

  const queueFlush = overrides.queueFlush ?? vi.fn(async () => undefined);
  const queueRef: RefObject<MutationQueue> = { current: { flush: queueFlush } as unknown as MutationQueue };

  const viewportFlush = overrides.viewportFlush ?? vi.fn(async () => undefined);
  const viewportController = {
    handleViewportChanged: vi.fn(),
    flush: viewportFlush,
  } as unknown as ReturnType<typeof useViewportController>;

  const navigation = navigationStub();
  mocks.useBoardNavigation.mockReturnValue(navigation);

  const cardsRef: RefObject<CardDto[]> = { current: [note()] };
  const cardWrites = createCardWrites(cardsRef, { current: [] }, dispatch);
  const deps: BoardLoadingDeps = { gateway, dispatch, cardWrites, queueRef, viewportController };
  const { result, unmount } = renderHook(() => useBoardLoading(deps));

  return {
    result,
    unmount,
    dispatch,
    cardWrites,
    cardsRef,
    getHomeBoard,
    loadBoardSnapshot,
    navigation,
    queueFlush,
    viewportFlush,
  };
}

describe("useBoardLoading", () => {
  beforeEach(() => {
    mocks.useBoardNavigation.mockReset();
    mocks.flushAllDrafts.mockReset().mockImplementation(async () => undefined);
  });

  describe("initial load", () => {
    it("dispatches loading, loads the home board's snapshot, seeds navigation, then dispatches it", async () => {
      const home = board({ id: "home" });
      const snap = snapshot({ board: home });
      const test = harness({
        getHomeBoard: vi.fn(async () => home),
        loadBoardSnapshot: vi.fn(async () => snap),
      });

      // The "loading" dispatch runs synchronously, before the first await.
      expect(test.dispatch).toHaveBeenNthCalledWith(1, { type: "loading" });

      await waitFor(() =>
        expect(test.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "snapshotLoaded" })),
      );

      expect(test.loadBoardSnapshot).toHaveBeenCalledWith("home");
      expect(test.navigation.initialize).toHaveBeenCalledWith(snap);

      // Navigation is seeded before the snapshot reaches the store.
      const initializeOrder = (test.navigation.initialize as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const snapshotLoadedCall = test.dispatch.mock.calls.findIndex((c) => c[0].type === "snapshotLoaded");
      const dispatchOrder = test.dispatch.mock.invocationCallOrder[snapshotLoadedCall];
      expect(initializeOrder).toBeLessThan(dispatchOrder);
    });

    it("dispatches failed when the load rejects", async () => {
      const test = harness({
        loadBoardSnapshot: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      await waitFor(() => expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" }));
    });

    it("dispatches nothing after unmount even once the load resolves (cancelled guard)", async () => {
      let resolveHome!: (b: BoardSummary) => void;
      const getHomeBoard = vi.fn(
        () =>
          new Promise<BoardSummary>((resolve) => {
            resolveHome = resolve;
          }),
      );
      const test = harness({ getHomeBoard });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "loading" });
      test.dispatch.mockClear();
      test.unmount();

      await act(async () => {
        resolveHome(board());
        // Flush the load's remaining `await`s (loadBoardSnapshot resolves too).
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(test.dispatch).not.toHaveBeenCalled();
      expect(test.navigation.initialize).not.toHaveBeenCalled();
    });
  });

  describe("applySnapshot (navigation's onSnapshotLoaded)", () => {
    it("normalizes note documentJson in cards and unsortedCards, leaves other kinds untouched, and maps the viewport", () => {
      const test = harness();
      const options = mocks.useBoardNavigation.mock.calls[0][0];
      expect(options.onSnapshotLoaded).toBeDefined();

      const badNote = note({ id: "n1", documentJson: { bogus: true } });
      const okPortal = portal({ id: "p1" });
      const unsortedNote = note({ id: "n2", documentJson: { type: "doc", content: [] } });
      const snap = snapshot({
        cards: [badNote, okPortal],
        unsortedCards: [unsortedNote],
        viewport: { x: 5, y: 6, zoom: 2, revision: 9 },
      });

      test.dispatch.mockClear();
      act(() => options.onSnapshotLoaded(snap, test.cardWrites.snapshotRequested()));

      expect(test.dispatch).toHaveBeenCalledWith({
        type: "snapshotLoaded",
        board: snap.board,
        breadcrumbs: snap.breadcrumbs,
        viewport: { x: 5, y: 6, zoom: 2 },
        viewportRevision: 9,
        cards: [
          { ...badNote, documentJson: { type: "doc", content: [{ type: "paragraph", content: [] }] } },
          okPortal,
        ],
        unsortedCards: [{ ...unsortedNote, documentJson: { type: "doc", content: [] } }],
        sinceRequest: { written: [], added: [], removed: [] },
      });
    });

    it("names the cards whose write answer was applied after the snapshot was requested", () => {
      const test = harness();
      const options = mocks.useBoardNavigation.mock.calls[0][0];
      act(() => options.onSnapshotLoaded(snapshot({ cards: [note()] }), options.stampSnapshotRequest()));
      const stamp = options.stampSnapshotRequest();
      test.cardWrites.apply({ type: "cardMoved", id: "note-1", revision: 2, frame: note().frame });

      test.dispatch.mockClear();
      act(() => options.onSnapshotLoaded(snapshot({ cards: [note()] }), stamp));

      expect(test.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "snapshotLoaded",
          sinceRequest: { written: ["note-1"], added: [], removed: [] },
        }),
      );
    });

    it("brings cardsRef to the snapshot before React re-renders", () => {
      const test = harness();
      const options = mocks.useBoardNavigation.mock.calls[0][0];
      const external = note({ id: "note-1", revision: 9, plainText: "from MCP" });

      act(() => options.onSnapshotLoaded(snapshot({ cards: [external] }), options.stampSnapshotRequest()));

      // cardsRef здесь — простой объект: его меняет только сам applySnapshot.
      expect(test.cardsRef.current).toEqual([{ ...external, documentJson: { type: "doc", content: [] } }]);
    });
  });

  describe("drainPendingWrites", () => {
    it("flushes drafts, then the queue, then the viewport, in order", async () => {
      const order: string[] = [];
      mocks.flushAllDrafts.mockImplementation(async () => {
        order.push("drafts");
      });
      const test = harness({
        queueFlush: vi.fn(async () => {
          order.push("queue");
        }),
        viewportFlush: vi.fn(async () => {
          order.push("viewport");
        }),
      });

      const options = mocks.useBoardNavigation.mock.calls[0][0];
      await options.drainPendingWrites("switch");

      expect(order).toEqual(["drafts", "queue", "viewport"]);
      expect(test.queueFlush).toHaveBeenCalledTimes(1);
      expect(test.viewportFlush).toHaveBeenCalledTimes(1);
    });

    it("finalizes drafts and marks the switch pending when leaving the board", async () => {
      const test = harness();
      const options = mocks.useBoardNavigation.mock.calls[0][0];

      await options.drainPendingWrites("switch");

      expect(mocks.flushAllDrafts).toHaveBeenLastCalledWith("finalize");
      expect(test.dispatch).toHaveBeenCalledWith({ type: "boardSwitchStarted" });
    });

    it("only saves drafts, and keeps editing, on a reload of the open board", async () => {
      const test = harness();
      const options = mocks.useBoardNavigation.mock.calls[0][0];

      await options.drainPendingWrites("reload");

      expect(mocks.flushAllDrafts).toHaveBeenLastCalledWith("save");
      expect(test.dispatch).not.toHaveBeenCalledWith({ type: "boardSwitchStarted" });
    });
  });
});
