import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TrashSummaryDto, WorkspaceGateway } from "../services/workspace-gateway";
import { useTrashController } from "./use-trash-controller";

function summary(batchCount: number): TrashSummaryDto {
  return { batchCount, boardCount: 0, cardCount: 0 } as unknown as TrashSummaryDto;
}

function harness(
  overrides: {
    listTrash?: ReturnType<typeof vi.fn>;
    restoreTrashBatch?: ReturnType<typeof vi.fn>;
    emptyTrash?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const listTrash = overrides.listTrash ?? vi.fn(async () => summary(1));
  const restoreTrashBatch = overrides.restoreTrashBatch ?? vi.fn(async () => {});
  const emptyTrash = overrides.emptyTrash ?? vi.fn(async () => {});
  const reloadCurrentBoard = vi.fn(async () => {});
  const reloadQuickBoards = vi.fn();
  const reloadBoardRef = { current: reloadCurrentBoard as (() => Promise<void>) | null };

  // The gateway is stable across renders, exactly as App builds it with
  // useMemo: a fresh object would restart the mount effect on every render.
  const gateway = { listTrash, restoreTrashBatch, emptyTrash } as unknown as WorkspaceGateway;
  const { result } = renderHook(() =>
    useTrashController({ gateway, reloadBoardRef, reloadQuickBoards }),
  );

  return { result, listTrash, restoreTrashBatch, emptyTrash, reloadCurrentBoard, reloadQuickBoards };
}

describe("useTrashController", () => {
  it("loads the summary on mount and refreshes the badge", async () => {
    const test = harness();
    await waitFor(() => expect(test.result.current.summary).toEqual(summary(1)));

    test.listTrash.mockResolvedValue(summary(3));
    await act(async () => {
      await test.result.current.refresh();
    });

    expect(test.result.current.summary).toEqual(summary(3));
  });

  it("opens the drawer with a fresh load and clears the error on close", async () => {
    const test = harness({ listTrash: vi.fn(async () => summary(2)) });
    await waitFor(() => expect(test.result.current.summary).not.toBeNull());

    act(() => test.result.current.openDrawer());
    expect(test.result.current.open).toBe(true);
    expect(test.result.current.loading).toBe(true);

    await waitFor(() => expect(test.result.current.loading).toBe(false));
    expect(test.listTrash).toHaveBeenCalledTimes(2);

    act(() => test.result.current.closeDrawer());
    expect(test.result.current.open).toBe(false);
    expect(test.result.current.error).toBeNull();
  });

  it("reports a failed summary load instead of throwing", async () => {
    const test = harness({
      listTrash: vi.fn(async () => {
        throw new Error("trash unavailable");
      }),
    });

    await waitFor(() => expect(test.result.current.error).toBe("trash unavailable"));
    expect(test.result.current.summary).toBeNull();
  });

  it("restores a batch, then reconciles the board and the Quick Boards rail", async () => {
    const order: string[] = [];
    const test = harness({
      restoreTrashBatch: vi.fn(async () => {
        order.push("restore");
      }),
    });
    test.reloadCurrentBoard.mockImplementation(async () => {
      order.push("board");
    });
    test.reloadQuickBoards.mockImplementation(() => {
      order.push("quick");
    });

    await act(async () => {
      await test.result.current.restoreBatch("batch-1");
    });

    expect(order).toEqual(["restore", "board", "quick"]);
    expect(test.result.current.restoringBatchId).toBeNull();
  });

  it("keeps the drawer usable when a restore fails", async () => {
    const test = harness({
      restoreTrashBatch: vi.fn(async () => {
        throw new Error("batch is gone");
      }),
    });

    await act(async () => {
      await test.result.current.restoreBatch("batch-1");
    });

    expect(test.result.current.error).toBe("batch is gone");
    expect(test.result.current.restoringBatchId).toBeNull();
    expect(test.reloadCurrentBoard).not.toHaveBeenCalled();
  });

  it("requires the confirmation phrase and closes the dialog on success", async () => {
    const test = harness();
    await waitFor(() => expect(test.result.current.summary).not.toBeNull());

    act(() => test.result.current.requestEmpty());
    expect(test.result.current.emptyDialogOpen).toBe(true);

    await act(async () => {
      await test.result.current.confirmEmpty("EMPTY");
    });

    expect(test.emptyTrash).toHaveBeenCalledWith("EMPTY");
    expect(test.result.current.emptyDialogOpen).toBe(false);
    expect(test.result.current.emptyBusy).toBe(false);
    expect(test.reloadCurrentBoard).toHaveBeenCalledTimes(1);
    expect(test.reloadQuickBoards).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open with the failure visible when emptying fails", async () => {
    const test = harness({
      emptyTrash: vi.fn(async () => {
        throw new Error("type EMPTY to confirm");
      }),
    });
    await waitFor(() => expect(test.result.current.summary).not.toBeNull());

    act(() => test.result.current.requestEmpty());
    await act(async () => {
      await test.result.current.confirmEmpty("wrong");
    });

    expect(test.result.current.emptyDialogOpen).toBe(true);
    expect(test.result.current.emptyError).toBe("type EMPTY to confirm");
    expect(test.result.current.emptyBusy).toBe(false);
    expect(test.reloadCurrentBoard).not.toHaveBeenCalled();
  });

  it("clears a previous empty failure when the dialog is reopened", async () => {
    const test = harness({
      emptyTrash: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await waitFor(() => expect(test.result.current.summary).not.toBeNull());

    act(() => test.result.current.requestEmpty());
    await act(async () => {
      await test.result.current.confirmEmpty("x");
    });
    expect(test.result.current.emptyError).toBe("nope");

    act(() => test.result.current.cancelEmpty());
    expect(test.result.current.emptyDialogOpen).toBe(false);

    act(() => test.result.current.requestEmpty());
    expect(test.result.current.emptyError).toBeNull();
  });
});
