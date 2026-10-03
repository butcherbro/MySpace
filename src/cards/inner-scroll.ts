import { useEffect, type RefObject } from "react";

/**
 * Whether a vertical wheel step of `deltaY` scrolls a card's own text rather
 * than the canvas: only while there is text left to scroll in that direction,
 * so at the top/bottom edge the wheel hands over to the canvas again.
 */
export function wheelScrollsInside(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  deltaY: number,
): boolean {
  if (deltaY > 0) return box.scrollTop + box.clientHeight < box.scrollHeight - 1;
  if (deltaY < 0) return box.scrollTop > 0;
  return false;
}

/**
 * While `active` (the card is being edited), the wheel over `ref` scrolls its
 * text instead of panning the canvas, until the text's edge. React Flow listens
 * for the wheel on an ancestor (its renderer), so keeping the event from
 * bubbling is enough; the element's native scroll runs by itself. Ctrl/Cmd
 * (zoom) and Shift (horizontal pan) always stay with the canvas.
 */
export function useInnerWheelScroll(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (wheelScrollsInside(el, event.deltaY)) event.stopPropagation();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref, active]);
}
