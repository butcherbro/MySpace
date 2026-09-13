import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanvasViewport } from "../canvas/canvas-types";
import type { WorkspaceGateway } from "../services/workspace-gateway";
import { useViewportPersistence } from "./use-viewport-persistence";

type Invoke = ReturnType<typeof vi.fn>;

function gatewayWith(saveViewport: Invoke): WorkspaceGateway {
  return { saveViewport } as unknown as WorkspaceGateway;
}

function viewport(zoom: number): CanvasViewport {
  return { x: 0, y: 0, zoom };
}

/** Wait until the gateway has seen `count` calls, without a fixed delay guess. */
async function flushUntil(saveViewport: Invoke, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (saveViewport.mock.calls.length >= count) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(`gateway saw ${saveViewport.mock.calls.length} calls, expected ${count}`);
}

describe("useViewportPersistence", () => {
  it("writes the board id and revision captured when the viewport settled", async () => {
    // Board A settles at revision 7. The user switches to board B (revision 1)
    // before the debounce elapses. The save must still carry A and revision 7:
    // reading a shared revision at timer time is what sent A's viewport with B's
    // revision and produced a stale-revision banner on B.
    const saveViewport = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 0, onSaved }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 7, viewport: viewport(1.5) }),
    );
    await flushUntil(saveViewport, 1);

    expect(saveViewport).toHaveBeenCalledWith({
      boardId: "board-a",
      expectedRevision: 7,
      x: 0,
      y: 0,
      zoom: 1.5,
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: "board-a", revision: 7 }),
    );
  });

  it("flushes the pending save before navigation proceeds", async () => {
    const saveViewport = vi.fn().mockResolvedValue(undefined);
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 10_000 }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 7, viewport: viewport(2) }),
    );
    // The debounce is far in the future; navigation must force the write instead.
    expect(saveViewport).not.toHaveBeenCalled();

    await act(async () => {
      await hook.current.flush();
    });

    expect(saveViewport).toHaveBeenCalledTimes(1);
    expect(saveViewport.mock.calls[0][0]).toEqual({
      boardId: "board-a",
      expectedRevision: 7,
      x: 0,
      y: 0,
      zoom: 2,
    });
  });

  it("writes nothing twice when flush follows a timer that already fired", async () => {
    const saveViewport = vi.fn().mockResolvedValue(undefined);
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 0 }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 3, viewport: viewport(1) }),
    );
    await flushUntil(saveViewport, 1);
    await act(async () => {
      await hook.current.flush();
    });

    expect(saveViewport).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending save without writing it", async () => {
    const saveViewport = vi.fn().mockResolvedValue(undefined);
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 0 }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 4, viewport: viewport(1) }),
    );
    act(() => hook.current.cancel());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(saveViewport).not.toHaveBeenCalled();
  });

  it("reports a failure together with the record it belongs to", async () => {
    // The caller filters on the record so a rejection for the previous board can
    // never raise a banner on the board that is on screen now.
    const saveViewport = vi.fn().mockRejectedValue(new Error("stale revision"));
    const onError = vi.fn();
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 0, onError }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 7, viewport: viewport(1) }),
    );
    await act(async () => {
      await hook.current.flush();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, save] = onError.mock.calls[0] as [Error, { boardId: string; revision: number }];
    expect(error.message).toBe("stale revision");
    expect(save.boardId).toBe("board-a");
    expect(save.revision).toBe(7);
  });

  it("keeps the newest settled viewport when several changes arrive in one window", async () => {
    const saveViewport = vi.fn().mockResolvedValue(undefined);
    const { result: hook } = renderHook(() =>
      useViewportPersistence(gatewayWith(saveViewport), { delayMs: 10_000 }),
    );

    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 7, viewport: viewport(1) }),
    );
    act(() =>
      hook.current.schedule({ boardId: "board-a", revision: 7, viewport: viewport(3) }),
    );
    await act(async () => {
      await hook.current.flush();
    });

    expect(saveViewport).toHaveBeenCalledTimes(1);
    expect(saveViewport.mock.calls[0][0].zoom).toBe(3);
  });
});
