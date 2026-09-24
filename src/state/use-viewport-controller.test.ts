import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGateway } from "../services/workspace-gateway";
import { useViewportController } from "./use-viewport-controller";

function gatewayWith(saveViewport: ReturnType<typeof vi.fn>): WorkspaceGateway {
  return { saveViewport } as unknown as WorkspaceGateway;
}

const settled = { x: 0, y: 0, zoom: 1.75 };

describe("useViewportController", () => {
  it("pins the save to the board and revision that were current when it settled", async () => {
    const saveViewport = vi.fn().mockResolvedValue({ revision: 8 });
    const onSettled = vi.fn();
    const { result, rerender } = renderHook(
      (props: { boardId: string | null; revision: number }) =>
        useViewportController({
          gateway: gatewayWith(saveViewport),
          boardId: props.boardId,
          revision: props.revision,
          onSettled,
          onSaved: vi.fn(),
          onError: vi.fn(),
          delayMs: 0,
        }),
      { initialProps: { boardId: "board-a", revision: 7 } },
    );

    act(() => result.current.handleViewportChanged({ viewport: settled }));
    // The user navigates away before the debounce elapses: the pending save must
    // still carry board A and revision 7, not the board that replaced it.
    rerender({ boardId: "board-b", revision: 1 });

    expect(onSettled).toHaveBeenCalledWith(settled);
    await waitFor(() =>
      expect(saveViewport).toHaveBeenCalledWith({
        boardId: "board-a",
        expectedRevision: 7,
        x: 0,
        y: 0,
        zoom: 1.75,
      }),
    );
  });

  it("never persists a pan, only the zoom, and pins the board to its origin", () => {
    const onSettled = vi.fn();
    const { result } = renderHook(() =>
      useViewportController({
        gateway: gatewayWith(vi.fn().mockResolvedValue({ revision: 2 })),
        boardId: "board-a",
        revision: 1,
        onSettled,
        onSaved: vi.fn(),
        onError: vi.fn(),
        delayMs: 0,
      }),
    );

    act(() => result.current.handleViewportChanged({ viewport: { x: 120, y: 80, zoom: 0.5 } }));

    expect(onSettled).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 0.5 });
  });

  it("ignores a late save that belongs to a board the user has left", async () => {
    const saveViewport = vi.fn().mockResolvedValue({ revision: 2 });
    const onSaved = vi.fn();
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      (props: { boardId: string | null }) =>
        useViewportController({
          gateway: gatewayWith(saveViewport),
          boardId: props.boardId,
          revision: 1,
          onSettled: vi.fn(),
          onSaved,
          onError,
          delayMs: 0,
        }),
      { initialProps: { boardId: "board-a" as string | null } },
    );

    act(() => result.current.handleViewportChanged({ viewport: settled }));
    rerender({ boardId: "board-b" });

    await waitFor(() => expect(saveViewport).toHaveBeenCalledTimes(1));
    // The save landed for board A while board B is open: surfacing it on B is the
    // stale-revision banner bug, so neither callback may fire.
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports the saved board's new revision to the caller", async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useViewportController({
        gateway: gatewayWith(vi.fn().mockResolvedValue({ revision: 5 })),
        boardId: "board-a",
        revision: 4,
        onSettled: vi.fn(),
        onSaved,
        onError: vi.fn(),
        delayMs: 0,
      }),
    );

    act(() => result.current.handleViewportChanged({ viewport: settled }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(5));
  });

  it("flushes a pending save for navigation and for the close barrier", async () => {
    const saveViewport = vi.fn().mockResolvedValue({ revision: 3 });
    const { result } = renderHook(() =>
      useViewportController({
        gateway: gatewayWith(saveViewport),
        boardId: "board-a",
        revision: 2,
        onSettled: vi.fn(),
        onSaved: vi.fn(),
        onError: vi.fn(),
        delayMs: 10_000,
      }),
    );

    act(() => result.current.handleViewportChanged({ viewport: settled }));
    expect(saveViewport).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.flush();
    });

    expect(saveViewport).toHaveBeenCalledTimes(1);
  });
});
