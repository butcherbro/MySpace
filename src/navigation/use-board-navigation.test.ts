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
  const drainPendingWrites = vi.fn<(reason: "switch" | "reload") => Promise<void>>(async () => {});
  const onSnapshotLoaded = vi.fn();
  const onSwitchAbandoned = vi.fn();
  const stampSnapshotRequest = vi.fn(() => 42);
  const gateway = { loadBoardSnapshot } as unknown as WorkspaceGateway;

  const { result } = renderHook(() =>
    useBoardNavigation({ gateway, drainPendingWrites, stampSnapshotRequest, onSnapshotLoaded, onSwitchAbandoned }),
  );

  act(() => result.current.initialize(snapshot("home")));
  return { result, loadBoardSnapshot, drainPendingWrites, stampSnapshotRequest, onSnapshotLoaded, onSwitchAbandoned };
}

describe("useBoardNavigation", () => {
  it("drains for a reload so editing goes on, and for a switch so it ends", async () => {
    const test = harness(async (boardId) => snapshot(boardId));

    await act(async () => {
      await test.result.current.navigateTo("home", { reload: true });
      await test.result.current.navigateTo("board-b");
    });

    expect(test.drainPendingWrites.mock.calls).toEqual([["reload"], ["switch"]]);
    expect(test.onSwitchAbandoned).not.toHaveBeenCalled();
  });

  it("reports a switch that ended without loading the board", async () => {
    const test = harness(async () => {
      throw new Error("load failed");
    });

    await act(async () => {
      await test.result.current.navigateTo("board-b").catch(() => undefined);
    });

    expect(test.onSwitchAbandoned).toHaveBeenCalledTimes(1);
  });

  it("stamps the snapshot request after draining and before loading, and hands the stamp over with the snapshot", async () => {
    const order: string[] = [];
    const test = harness(async (boardId) => {
      order.push("load");
      return snapshot(boardId);
    });
    test.drainPendingWrites.mockImplementation(async () => {
      order.push("drain");
    });
    test.stampSnapshotRequest.mockImplementation(() => {
      order.push("stamp");
      return 42;
    });

    await act(async () => {
      await test.result.current.navigateTo("home");
    });

    expect(order).toEqual(["drain", "stamp", "load"]);
    expect(test.onSnapshotLoaded).toHaveBeenCalledWith(snapshot("home"), 42);
  });

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

  describe("reload of the open board", () => {
    const tick = async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    it("does not cancel a switch to another board that is still draining its writes", async () => {
      // Вкладка C нажата, пока в очереди доски B автосейв; он падает с
      // stale_revision, и обёртка шлёт перезагрузку текущей доски.
      let releaseDrain!: () => void;
      const test = harness(async (boardId) => snapshot(boardId));
      test.drainPendingWrites.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseDrain = resolve;
          }),
      );

      await act(async () => {
        const toC = test.result.current.navigateTo("board-c", { tabMode: "open" });
        await tick();
        const reload = test.result.current.navigateTo("home", { reload: true });
        await tick();
        releaseDrain();
        await Promise.all([toC, reload]);
      });

      expect(test.loadBoardSnapshot.mock.calls.map(([id]) => id)).toEqual(["board-c"]);
      expect(test.onSnapshotLoaded).toHaveBeenCalledTimes(1);
      expect(test.result.current.tabs?.activeBoardId).toBe("board-c");
    });

    it("does not cancel a switch that is already loading its snapshot (the change_seq poll case)", async () => {
      const releases: Array<() => void> = [];
      const test = harness(
        (boardId) =>
          new Promise<BoardSnapshot>((resolve) => {
            releases.push(() => resolve(snapshot(boardId)));
          }),
      );

      await act(async () => {
        const toC = test.result.current.navigateTo("board-c", { tabMode: "open" });
        await tick();
        // Опрос change_seq ещё видит открытой «home» и перезагружает её.
        await test.result.current.navigateTo("home", { reload: true });
        releases[0]();
        await toC;
      });

      expect(test.loadBoardSnapshot).toHaveBeenCalledTimes(1);
      expect(test.result.current.tabs?.activeBoardId).toBe("board-c");
    });

    it("still supersedes an older reload of the same board", async () => {
      const releases: Array<() => void> = [];
      const loaded: string[] = [];
      const test = harness(
        (boardId) =>
          new Promise<BoardSnapshot>((resolve) => {
            const n = releases.length;
            releases.push(() => resolve(snapshot(boardId, `${boardId}-${n}`)));
          }),
      );
      test.onSnapshotLoaded.mockImplementation((s: BoardSnapshot) => loaded.push(s.board.title));

      await act(async () => {
        const first = test.result.current.navigateTo("home", { reload: true });
        await tick();
        const second = test.result.current.navigateTo("home", { reload: true });
        await tick();
        releases[1]();
        releases[0]();
        await Promise.all([first, second]);
      });

      expect(loaded).toEqual(["home-1"]);
    });

    /** Loads that the test settles by hand, per board, in call order. */
    function manualLoads() {
      const pending: Array<{ boardId: string; resolve: () => void; reject: (e: unknown) => void }> = [];
      const test = harness(
        (boardId) =>
          new Promise<BoardSnapshot>((resolve, reject) => {
            pending.push({ boardId, resolve: () => resolve(snapshot(boardId)), reject });
          }),
      );
      return { test, pending };
    }

    it("runs a reload it yielded to a switch once that switch fails", async () => {
      // Переход на B, пока sync-applied просит перезагрузить A; загрузка B падает.
      const { test, pending } = manualLoads();

      await act(async () => {
        const toB = test.result.current.navigateTo("board-b", { tabMode: "open" }).catch(() => undefined);
        await tick();
        await test.result.current.navigateTo("home", { reload: true });
        pending[0].reject(new Error("board-b is gone"));
        await toB;
        await tick();
        pending[1]?.resolve();
        await tick();
      });

      expect(pending.map((p) => p.boardId)).toEqual(["board-b", "home"]);
      expect(test.onSnapshotLoaded).toHaveBeenCalledTimes(1);
      expect(test.onSnapshotLoaded.mock.calls[0][0].board.id).toBe("home");
    });

    it("discards the yielded reload when the switch succeeds", async () => {
      const { test, pending } = manualLoads();

      await act(async () => {
        const toB = test.result.current.navigateTo("board-b", { tabMode: "open" });
        await tick();
        await test.result.current.navigateTo("home", { reload: true });
        pending[0].resolve();
        await toB;
        await tick();
      });

      expect(pending.map((p) => p.boardId)).toEqual(["board-b"]);
      expect(test.result.current.tabs?.activeBoardId).toBe("board-b");
    });

    it("lets later reloads through after a switch failed", async () => {
      const { test, pending } = manualLoads();

      await act(async () => {
        const toB = test.result.current.navigateTo("board-b", { tabMode: "open" }).catch(() => undefined);
        await tick();
        pending[0].reject(new Error("board-b is gone"));
        await toB;
        const reload = test.result.current.navigateTo("home", { reload: true });
        await tick();
        pending[1]?.resolve();
        await reload;
      });

      expect(pending.map((p) => p.boardId)).toEqual(["board-b", "home"]);
    });

    it("does not supersede a user navigation to the same board, so its history push survives", async () => {
      const { test, pending } = manualLoads();

      await act(async () => {
        const toB = test.result.current.navigateTo("board-b", { pushHistory: true, tabMode: "open" });
        await tick();
        await test.result.current.navigateTo("board-b", { reload: true });
        pending[0].resolve();
        await toB;
      });
      expect(pending.map((p) => p.boardId)).toEqual(["board-b"]);

      // История записала переход: «назад» ведёт на home.
      act(() => test.result.current.goBack());
      await act(async () => {
        await tick();
      });
      expect(pending.map((p) => p.boardId)).toEqual(["board-b", "home"]);
    });
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
        stampSnapshotRequest: () => 0,
        onSnapshotLoaded,
      }),
    );

    await act(async () => {
      await result.current.navigateTo("board-b", { tabMode: "sync" });
    });

    expect(result.current.tabs?.activeBoardId).toBe("board-b");
  });
});
