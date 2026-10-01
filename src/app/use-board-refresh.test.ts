import { act, renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { BoardNavigation } from "../navigation/use-board-navigation";
import type { BoardChangeSeq, BoardSummary, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useBoardRefresh, type BoardRefreshDeps } from "./use-board-refresh";

const mocks = vi.hoisted(() => ({
  useSyncAppliedReload: vi.fn(),
}));

vi.mock("../sync/use-sync-state", () => ({
  useSyncAppliedReload: mocks.useSyncAppliedReload,
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

function changeSeq(overrides: Partial<BoardChangeSeq> = {}): BoardChangeSeq {
  return { dataVersion: 1, changeSeq: 1, ...overrides };
}

function harness(
  overrides: {
    board?: BoardSummary | null;
    undo?: () => Promise<boolean>;
    redo?: () => Promise<boolean>;
    getBoardChangeSeq?: (boardId: string) => Promise<BoardChangeSeq>;
    navigateTo?: BoardNavigation["navigateTo"];
    refreshTrash?: () => Promise<void>;
    loadQuickBoards?: () => void;
  } = {},
) {
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();
  const undo = overrides.undo ?? vi.fn(async () => true);
  const redo = overrides.redo ?? vi.fn(async () => true);
  const dispatcher = { undo, redo } as unknown as CommandDispatcher;
  const getBoardChangeSeq = overrides.getBoardChangeSeq ?? vi.fn(async () => changeSeq());
  const gateway = { getBoardChangeSeq } as unknown as WorkspaceGateway;
  const navigateTo = overrides.navigateTo ?? vi.fn(async () => undefined);
  const refreshTrash = overrides.refreshTrash ?? vi.fn(async () => undefined);
  const loadQuickBoards = overrides.loadQuickBoards ?? vi.fn();
  const reloadBoardRef: RefObject<(() => Promise<void>) | null> = { current: null };

  const initialDeps: BoardRefreshDeps = {
    gateway,
    board: overrides.board === undefined ? board() : overrides.board,
    dispatcher,
    dispatch,
    navigateTo,
    refreshTrash,
    loadQuickBoards,
    reloadBoardRef,
  };

  const { result, unmount, rerender } = renderHook((props: BoardRefreshDeps) => useBoardRefresh(props), {
    initialProps: initialDeps,
  });

  return {
    result,
    unmount,
    rerender,
    deps: initialDeps,
    gateway,
    dispatch,
    undo,
    redo,
    getBoardChangeSeq,
    navigateTo,
    refreshTrash,
    loadQuickBoards,
    reloadBoardRef,
  };
}

/** Advances the fake-timer poll and flushes the gateway promise chain it starts. */
async function tick(ms = 0) {
  await act(async () => {
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useBoardRefresh", () => {
  beforeEach(() => {
    mocks.useSyncAppliedReload.mockReset();
  });

  describe("reloadCurrentBoard", () => {
    it("navigates to the open board", async () => {
      const test = harness({ board: board({ id: "b1" }) });

      await act(async () => {
        await test.result.current.reloadCurrentBoard();
      });

      expect(test.navigateTo).toHaveBeenCalledWith("b1", { reload: true });
    });

    it("does nothing when no board is open", async () => {
      const test = harness({ board: null });

      await act(async () => {
        await test.result.current.reloadCurrentBoard();
      });

      expect(test.navigateTo).not.toHaveBeenCalled();
    });

    it("sets reloadBoardRef.current to reloadCurrentBoard", () => {
      const test = harness();

      expect(test.reloadBoardRef.current).toBe(test.result.current.reloadCurrentBoard);
    });
  });

  describe("handleWorkspaceUndo", () => {
    it("reloads the board when undo() resolves true", async () => {
      const test = harness({ board: board({ id: "b1" }), undo: vi.fn(async () => true) });

      await act(async () => {
        await test.result.current.handleWorkspaceUndo();
      });

      expect(test.navigateTo).toHaveBeenCalledWith("b1", { reload: true });
    });

    it("does not reload when undo() resolves false", async () => {
      const test = harness({ board: board({ id: "b1" }), undo: vi.fn(async () => false) });

      await act(async () => {
        await test.result.current.handleWorkspaceUndo();
      });

      expect(test.navigateTo).not.toHaveBeenCalled();
    });

    it("dispatches failed when undo() rejects", async () => {
      const test = harness({
        undo: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      await act(async () => {
        await test.result.current.handleWorkspaceUndo();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" });
      expect(test.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe("handleWorkspaceRedo", () => {
    it("reloads the board when redo() resolves true", async () => {
      const test = harness({ board: board({ id: "b1" }), redo: vi.fn(async () => true) });

      await act(async () => {
        await test.result.current.handleWorkspaceRedo();
      });

      expect(test.navigateTo).toHaveBeenCalledWith("b1", { reload: true });
    });

    it("does not reload when redo() resolves false", async () => {
      const test = harness({ board: board({ id: "b1" }), redo: vi.fn(async () => false) });

      await act(async () => {
        await test.result.current.handleWorkspaceRedo();
      });

      expect(test.navigateTo).not.toHaveBeenCalled();
    });

    it("dispatches failed when redo() rejects", async () => {
      const test = harness({
        redo: vi.fn(async () => {
          throw new Error("boom");
        }),
      });

      await act(async () => {
        await test.result.current.handleWorkspaceRedo();
      });

      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "boom" });
      expect(test.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe("external-change poll", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("primes immediately on mount, then polls every 3000 ms", async () => {
      const getBoardChangeSeq = vi.fn(async () => changeSeq());
      harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick();
      expect(getBoardChangeSeq).toHaveBeenCalledTimes(1);
      expect(getBoardChangeSeq).toHaveBeenCalledWith("b1");

      await tick(3000);
      expect(getBoardChangeSeq).toHaveBeenCalledTimes(2);

      await tick(3000);
      expect(getBoardChangeSeq).toHaveBeenCalledTimes(3);
    });

    it("reloads the board and refreshes trash once shouldReload's inputs say so", async () => {
      const samples = [changeSeq({ dataVersion: 1, changeSeq: 1 }), changeSeq({ dataVersion: 2, changeSeq: 2 })];
      let call = 0;
      const getBoardChangeSeq = vi.fn(async () => samples[Math.min(call++, samples.length - 1)]);
      const test = harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick(); // primes the baseline; a first sample never reloads
      expect(test.navigateTo).not.toHaveBeenCalled();
      expect(test.refreshTrash).not.toHaveBeenCalled();

      await tick(3000); // dataVersion AND changeSeq moved
      expect(test.navigateTo).toHaveBeenCalledWith("b1", { reload: true });
      expect(test.refreshTrash).toHaveBeenCalledTimes(1);
    });

    it("refreshes trash without reloading when dataVersion moved but changeSeq did not", async () => {
      const samples = [changeSeq({ dataVersion: 1, changeSeq: 1 }), changeSeq({ dataVersion: 2, changeSeq: 1 })];
      let call = 0;
      const getBoardChangeSeq = vi.fn(async () => samples[Math.min(call++, samples.length - 1)]);
      const test = harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick();
      await tick(3000);

      expect(test.navigateTo).not.toHaveBeenCalled();
      expect(test.refreshTrash).toHaveBeenCalledTimes(1);
    });

    it("swallows a rejected poll", async () => {
      const getBoardChangeSeq = vi.fn(async () => {
        throw new Error("offline");
      });
      const test = harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick();

      expect(test.navigateTo).not.toHaveBeenCalled();
      expect(test.refreshTrash).not.toHaveBeenCalled();
      expect(test.dispatch).not.toHaveBeenCalled();
    });

    it("clears the interval on unmount", async () => {
      const getBoardChangeSeq = vi.fn(async () => changeSeq());
      const test = harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick();
      test.unmount();
      await tick(10000);

      expect(getBoardChangeSeq).toHaveBeenCalledTimes(1);
    });

    it("re-primes for the new board when it switches", async () => {
      const getBoardChangeSeq = vi.fn(async () => changeSeq());
      const test = harness({ board: board({ id: "b1" }), getBoardChangeSeq });

      await tick();
      expect(getBoardChangeSeq).toHaveBeenCalledWith("b1");

      test.rerender({ ...test.deps, board: board({ id: "b2" }) });
      await tick();

      expect(getBoardChangeSeq).toHaveBeenCalledWith("b2");
    });

    it("does not poll when no board is open", async () => {
      const getBoardChangeSeq = vi.fn(async () => changeSeq());
      harness({ board: null, getBoardChangeSeq });

      await tick(10000);

      expect(getBoardChangeSeq).not.toHaveBeenCalled();
    });
  });

  describe("sync-applied reload", () => {
    it("wires the reload callback to navigateTo and onApplied to refreshTrash + loadQuickBoards", () => {
      const test = harness({ board: board({ id: "b1" }) });

      expect(mocks.useSyncAppliedReload).toHaveBeenCalledTimes(1);
      const [gatewayArg, openBoardId, reloadBoard, onApplied] = mocks.useSyncAppliedReload.mock.calls[0];
      expect(gatewayArg).toBe(test.gateway);
      expect(openBoardId).toBe("b1");

      reloadBoard("board-X");
      expect(test.navigateTo).toHaveBeenCalledWith("board-X", { reload: true });

      onApplied();
      expect(test.refreshTrash).toHaveBeenCalledTimes(1);
      expect(test.loadQuickBoards).toHaveBeenCalledTimes(1);
    });
  });
});
