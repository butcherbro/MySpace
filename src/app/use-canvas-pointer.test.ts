import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasPointer, useCanvasPointerTracking } from "./use-canvas-pointer";

describe("useCanvasPointer", () => {
  it("resets the last point when boardOpenRevision changes", () => {
    const { result, rerender } = renderHook(
      ({ revision }: { revision: number }) => useCanvasPointer({ boardOpenRevision: revision }),
      { initialProps: { revision: 0 } },
    );
    result.current.lastCanvasPointRef.current = { x: 10, y: 20 };

    rerender({ revision: 1 });

    expect(result.current.lastCanvasPointRef.current).toBeNull();
  });
});

describe("useCanvasPointerTracking", () => {
  it("stores the flow coordinate on pointermove over the canvas element", () => {
    const el = document.createElement("div");
    const canvasRef = { current: el };
    const lastCanvasPointRef = { current: null as { x: number; y: number } | null };
    const screenToFlowRef = { current: (x: number, y: number) => ({ x: x + 1, y: y + 1 }) };

    renderHook(() => useCanvasPointerTracking({ canvasRef, lastCanvasPointRef, screenToFlowRef }));

    act(() => {
      el.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 7 }));
    });

    expect(lastCanvasPointRef.current).toEqual({ x: 6, y: 8 });
  });

  it("skips the move when screenToFlowRef isn't ready yet", () => {
    const el = document.createElement("div");
    const canvasRef = { current: el };
    const lastCanvasPointRef = { current: null as { x: number; y: number } | null };
    const screenToFlowRef = { current: null as ((x: number, y: number) => { x: number; y: number }) | null };

    renderHook(() => useCanvasPointerTracking({ canvasRef, lastCanvasPointRef, screenToFlowRef }));

    act(() => {
      el.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 7 }));
    });

    expect(lastCanvasPointRef.current).toBeNull();
  });

  it("removes the pointermove listener on unmount", () => {
    const el = document.createElement("div");
    const removeSpy = vi.spyOn(el, "removeEventListener");
    const canvasRef = { current: el };
    const lastCanvasPointRef = { current: null as { x: number; y: number } | null };
    const screenToFlowRef = { current: (x: number, y: number) => ({ x, y }) };

    const { unmount } = renderHook(() =>
      useCanvasPointerTracking({ canvasRef, lastCanvasPointRef, screenToFlowRef }),
    );

    unmount();

    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
  });
});
