import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QuickBoardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { useQuickBoards } from "./use-quick-boards";

function quickBoard(overrides: Partial<QuickBoardDto> = {}): QuickBoardDto {
  return {
    boardId: "board-1",
    title: "Board",
    colorToken: "default",
    symbol: null,
    sortOrder: 0,
    coverAsset: null,
    ...overrides,
  };
}

function harness(
  overrides: {
    listQuickBoards?: ReturnType<typeof vi.fn>;
    addQuickBoard?: ReturnType<typeof vi.fn>;
    removeQuickBoard?: ReturnType<typeof vi.fn>;
    reorderQuickBoards?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const listQuickBoards = overrides.listQuickBoards ?? vi.fn(async () => [quickBoard()]);
  const addQuickBoard = overrides.addQuickBoard ?? vi.fn(async () => undefined);
  const removeQuickBoard = overrides.removeQuickBoard ?? vi.fn(async () => undefined);
  const reorderQuickBoards = overrides.reorderQuickBoards ?? vi.fn(async () => undefined);

  const gateway = {
    listQuickBoards,
    addQuickBoard,
    removeQuickBoard,
    reorderQuickBoards,
  } as unknown as WorkspaceGateway;
  const dispatch = vi.fn<(action: CurrentBoardAction) => void>();

  const { result } = renderHook(() => useQuickBoards({ gateway, dispatch }));

  return { result, gateway, dispatch, listQuickBoards, addQuickBoard, removeQuickBoard, reorderQuickBoards };
}

describe("useQuickBoards", () => {
  it("loads the persisted list on mount", async () => {
    const boards = [quickBoard({ boardId: "board-1" }), quickBoard({ boardId: "board-2", sortOrder: 1 })];
    const test = harness({ listQuickBoards: vi.fn(async () => boards) });

    await waitFor(() => expect(test.result.current.quickBoards).toEqual(boards));
    expect(test.listQuickBoards).toHaveBeenCalledTimes(1);
  });

  it("dispatches a failure instead of throwing when the initial load rejects", async () => {
    const test = harness({
      listQuickBoards: vi.fn(async () => {
        throw new Error("workspace unavailable");
      }),
    });

    await waitFor(() =>
      expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "workspace unavailable" }),
    );
    expect(test.result.current.quickBoards).toEqual([]);
  });

  it("pins a board, then reloads the list from the gateway", async () => {
    const test = harness();
    await waitFor(() => expect(test.result.current.quickBoards).toEqual([quickBoard()]));

    const reloaded = [quickBoard(), quickBoard({ boardId: "board-2", sortOrder: 1 })];
    test.listQuickBoards.mockResolvedValueOnce(reloaded);

    await act(async () => {
      test.result.current.handleQuickBoardPin("board-2");
    });

    expect(test.addQuickBoard).toHaveBeenCalledWith({ boardId: "board-2" });
    await waitFor(() => expect(test.result.current.quickBoards).toEqual(reloaded));
  });

  it("removes a board, then reloads the list from the gateway", async () => {
    const test = harness({ listQuickBoards: vi.fn(async () => [quickBoard(), quickBoard({ boardId: "board-2" })]) });
    await waitFor(() => expect(test.result.current.quickBoards).toHaveLength(2));

    test.listQuickBoards.mockResolvedValueOnce([quickBoard()]);

    await act(async () => {
      test.result.current.handleQuickBoardRemove("board-2");
    });

    expect(test.removeQuickBoard).toHaveBeenCalledWith("board-2");
    await waitFor(() => expect(test.result.current.quickBoards).toEqual([quickBoard()]));
  });

  it("dispatches a failure instead of throwing when pin/remove reject", async () => {
    const test = harness({
      addQuickBoard: vi.fn(async () => {
        throw new Error("board not found");
      }),
    });
    await waitFor(() => expect(test.result.current.quickBoards).toEqual([quickBoard()]));

    await act(async () => {
      test.result.current.handleQuickBoardPin("missing-board");
    });

    expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "board not found" });
  });

  it("reorders optimistically, then persists the new order", async () => {
    const boards = [quickBoard({ boardId: "board-1" }), quickBoard({ boardId: "board-2", sortOrder: 1 })];
    const test = harness({ listQuickBoards: vi.fn(async () => boards) });
    await waitFor(() => expect(test.result.current.quickBoards).toEqual(boards));

    act(() => {
      test.result.current.handleQuickBoardsReorder(["board-2", "board-1"]);
    });

    expect(test.result.current.quickBoards).toEqual([
      quickBoard({ boardId: "board-2", sortOrder: 0 }),
      quickBoard({ boardId: "board-1", sortOrder: 1 }),
    ]);
    await waitFor(() =>
      expect(test.reorderQuickBoards).toHaveBeenCalledWith({ boardIds: ["board-2", "board-1"] }),
    );
  });

  it("dispatches a failure and reloads from the gateway when persisting the reorder fails", async () => {
    const boards = [quickBoard({ boardId: "board-1" }), quickBoard({ boardId: "board-2", sortOrder: 1 })];
    const test = harness({
      listQuickBoards: vi.fn(async () => boards),
      reorderQuickBoards: vi.fn(async () => {
        throw new Error("reorder rejected");
      }),
    });
    await waitFor(() => expect(test.result.current.quickBoards).toEqual(boards));

    test.listQuickBoards.mockResolvedValueOnce(boards);

    await act(async () => {
      test.result.current.handleQuickBoardsReorder(["board-2", "board-1"]);
    });

    expect(test.dispatch).toHaveBeenCalledWith({ type: "failed", message: "reorder rejected" });
    // Failed persist re-fetches the list, discarding the optimistic order.
    await waitFor(() => expect(test.listQuickBoards).toHaveBeenCalledTimes(2));
  });
});
