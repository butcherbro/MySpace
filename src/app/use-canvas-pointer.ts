import { useEffect, useRef, type RefObject } from "react";

/**
 * Canvas pointer tracking: the DOM ref for the canvas element and the last
 * known pointer position over it, in board-space (flow coordinates). Drives
 * paste placement (todo.md №15): pasted cards land under the cursor, not at
 * a fixed origin.
 *
 * Two hooks, not one: in `App` the reset effect and the pointermove effect
 * sit in different places in the hook order — the pointermove effect needs
 * `screenToFlowRef`, which `App` creates in between them — so each is kept at
 * its original spot instead of folding both into a single hook call, which
 * would move the pointermove listener's mount earlier than it runs today.
 *
 * Extracted from `App.tsx` (docs/plans/2026-09-26-app-tsx-split.md, step 14).
 */

export type FlowPoint = { x: number; y: number };

export interface CanvasPointerDeps {
  boardOpenRevision: number;
}

export function useCanvasPointer({ boardOpenRevision }: CanvasPointerDeps) {
  // A board switch (todo.md №25) must drop any pointer position tracked for
  // the *previous* board: this ref holds flow-space coordinates, meaningful
  // only relative to the React Flow instance that produced them. Falling
  // back to `null` means the very next paste uses `fallbackPastePosition()`
  // (viewport center) until a real pointermove re-establishes a same-board
  // position, instead of landing in whatever spot the stale coordinate maps
  // to on the new board.
  const lastCanvasPointRef = useRef<FlowPoint | null>(null);
  useEffect(() => {
    lastCanvasPointRef.current = null;
  }, [boardOpenRevision]);

  // Declared here so the paste callbacks defined elsewhere in App can close
  // over it: it's still the same DOM node either way, since the render
  // effect that attaches it (useCanvasPointerTracking) runs once for the
  // app's lifetime.
  const canvasRef = useRef<HTMLDivElement>(null);

  return { canvasRef, lastCanvasPointRef };
}

export interface CanvasPointerTrackingDeps {
  canvasRef: RefObject<HTMLDivElement | null>;
  lastCanvasPointRef: RefObject<FlowPoint | null>;
  screenToFlowRef: RefObject<((x: number, y: number) => FlowPoint) | null>;
}

// Tracks pointer position over the canvas in board-space, for paste
// placement. The canvas element is stable for the app's lifetime, so one
// listener suffices; screenToFlowRef may not be ready on the very first
// paint, in which case the move is simply skipped (next move catches up).
export function useCanvasPointerTracking({
  canvasRef,
  lastCanvasPointRef,
  screenToFlowRef,
}: CanvasPointerTrackingDeps): void {
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function handleMove(e: PointerEvent) {
      const flow = screenToFlowRef.current;
      if (!flow) return;
      lastCanvasPointRef.current = flow(e.clientX, e.clientY);
    }
    el.addEventListener("pointermove", handleMove);
    return () => el.removeEventListener("pointermove", handleMove);
    // Рефы стабильны по идентичности (созданы через useRef у вызывающей
    // стороны), но раз они пришли параметром хука, линтер этого не видит —
    // указываем явно, поведение не меняется (эффект всё равно монтируется
    // один раз).
  }, [canvasRef, lastCanvasPointRef, screenToFlowRef]);
}
