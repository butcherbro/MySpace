import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BoardSnapshot, WorkspaceGateway } from "../services/workspace-gateway";
import { useBoardNavigation } from "./use-board-navigation";

function snapshot(boardId: string, title = boardId): BoardSnapshot {
  return {
    board: {
      id: boardId,
      title,
      colorToken: "slate",
      symbol: null,
      coverAsset: null,
      revision: 1,
      parentBoardId: null,
      portalRevision: null,
    },
    breadcrumbs: [],
    viewport: { x: 0, y: 0, zoom: 1, revision: 1 },
    cards: [],
    unsortedCards: [],
  } as unknown as BoardSnapshot;
}

function harness(load: (boardId: string) => Promise<BoardSnapshot>) {
  const loadBoardSnapshot = vi.fn(load);
  const drainPendingWrites = vi.fn(async () => {});
  const onSnapshotLoaded = vi.fn();
  const gateway = { loadBoardSnapshot } as unknown as WorkspaceGateway;

  const { result } = renderHook(() =>
    useBoardNavigation({ gateway, drainPendingWrites, onSnapshotLoaded }),
  );

  act(() => result.current.initialize(snapshot("home")));
  return { result, loadBoardSnapshot, drainPendingWrites, onSnapshotLoaded };
}

describe("useBoardNavigation", () => {
  it("drains pending writes before loading, then applies the snapshot", async () => {
    const order: string[] = [];
    const test = harness(async (boardId) => {
      order.push(`load:${boardId}`);
      return snapshot(boardId);
    });
    test.drainPendingWrites.mockImplementation(async () => {
      order.push("drain");
    });

    await act(async () => {
      await test.result.current.navigateTo("board-b", { tabMode: "open" });
    });

    // The viewport flush writes the OUTGOING board, so it has to happen before
    // the new projection replaces the state.
    expect(order).toEqual(["drain", "load:board-b"]);
    expect(test.onSnapshotLoaded).toHaveBeenCalledTimes(1);
    expect(test.result.current.tabs?.tabs.map((t) => t.boardId)).toEqual(["home", "board-b"]);
    expect(test.result.current.tabs?.activeBoardId).toBe("board-b");
  });

  it("ignores a slow load that a newer navigation superseded", async () => {
    // The real race: the slow load has already been requested when the user
    // navigates again, and it comes back last.
    const releases: Array<() => void> = [];
    const test = harness(
      (boardId) =>
        new Promise<BoardSnapshot>((resolve) => {
          releases.push(() => resolve(snapshot(boardId)));
        }),
    );
    const tick = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    await act(async () => {
      const slow = test.result.current.navigateTo("board-slow", { tabMode: "open" });
      await tick();
      expect(test.loadBoardSnapshot).toHaveBeenCalledTimes(1);

      const fresh = test.result.current.navigateTo("board-fresh", { tabMode: "open" });
      await tick();
      expect(test.loadBoardSnapshot).toHaveBeenCalledTimes(2);

      // The newer navigation resolves first, the stale one lands after it.
      releases[1]();
      await fresh;
      releases[0]();
      await slow;
    });

    // Only the newest navigation may touch the store or the tabs.
    expect(test.onSnapshotLoaded).toHaveBeenCalledTimes(1);
    expect(test.result.current.tabs?.activeBoardId).toBe("board-fresh");
    expect(test.result.current.tabs?.tabs.map((t) => t.boardId)).toEqual(["home", "board-fresh"]);
  });

  it("does not even load a board the next navigation already replaced", async () => {
    const test = harness(async (boardId) => snapshot(boardId));

    await act(async () => {
      const first = test.result.current.navigateTo("board-a", { tabMode: "open" });
      const second = test.result.current.navigateTo("board-b", { tabMode: "open" });
      await Promise.all([first, second]);
    });

    // The superseded call returns before asking the gateway for anything.
    expect(test.loadBoardSnapshot).toHaveBeenCalledTimes(1);
    expect(test.loadBoardSnapshot).toHaveBeenCalledWith("board-b");
  });

  it("records history only when asked, and back/forward follow it", async () => {
    const test = harness(async (boardId) => snapshot(boardId));

    await act(async () => {
      await test.result.current.navigateTo("board-b", { pushHistory: true, tabMode: "open" });
    });
    await act(async () => {
      await test.result.current.navigateTo("board-c", { pushHistory: true, tabMode: "open" });
    });
    await act(async () => {
      await test.result.current.navigateTo("board-c", { tabMode: "sync" });
    });

    await act(async () => {
      test.result.current.goBack();
      await Promise.resolve();
    });
    expect(test.result.current.tabs?.activeBoardId).toBe("board-b");

    await act(async () => {
      test.result.current.goForward();
      await Promise.resolve();
    });
    expect(test.result.current.tabs?.activeBoardId).toBe("board-c");
  });

  it("closing the active tab navigates to its neighbour; closing another does not", async () => {
    const test = harness(async (boardId) => snapshot(boardId));
    await act(async () => {
      await test.result.current.navigateTo("board-b", { tabMode: "open" });
    });
    test.onSnapshotLoaded.mockClear();

    act(() => test.result.current.closeTab("board-b"));
    await act(async () => {
      await Promise.resolve();
    });

    // Closing the active tab falls back to the neighbour and loads it.
    expect(test.result.current.tabs?.activeBoardId).toBe("home");
    expect(test.onSnapshotLoaded).toHaveBeenCalledTimes(1);

    test.onSnapshotLoaded.mockClear();
    act(() => test.result.current.closeTab("home"));
    await act(async () => {
      await Promise.resolve();
    });

    // Home cannot be closed, and nothing was loaded: the active tab is unchanged.
    expect(test.result.current.tabs?.activeBoardId).toBe("home");
    expect(test.onSnapshotLoaded).not.toHaveBeenCalled();
  });

  it("activating an open tab loads it without pushing history", async () => {
    const test = harness(async (boardId) => snapshot(boardId));
    await act(async () => {
      await test.result.current.navigateTo("board-b", { tabMode: "open" });
    });

    act(() => test.result.current.activateTab("home"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(test.result.current.tabs?.activeBoardId).toBe("home");

    // No history was recorded for the tab switch, so back has nowhere to go.
    await act(async () => {
      test.result.current.goBack();
      await Promise.resolve();
    });
    expect(test.result.current.tabs?.activeBoardId).toBe("home");
  });

  it("syncs the active tab to the loaded board even when the tab list is empty", async () => {
    const loadBoardSnapshot = vi.fn(async (boardId: string) => snapshot(boardId));
    const gateway = { loadBoardSnapshot } as unknown as WorkspaceGateway;
    const onSnapshotLoaded = vi.fn();
    const { result } = renderHook(() =>
      useBoardNavigation({
        gateway,
        drainPendingWrites: async () => {},
        onSnapshotLoaded,
      }),
    );

    await act(async () => {
      await result.current.navigateTo("board-b", { tabMode: "sync" });
    });

    expect(result.current.tabs?.activeBoardId).toBe("board-b");
  });
});
