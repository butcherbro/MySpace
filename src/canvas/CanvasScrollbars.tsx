import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import {
  computeScrollbars,
  pageDirection,
  pageViewMin,
  thumbDragToViewMin,
  viewMinToTranslate,
  type AxisGeometry,
} from "./scrollbar-geometry";
import "./canvas-scrollbars.css";

const MIN_THUMB_PX = 32;
/** Hit strip thickness; also the corner reserved when both bars show. */
const STRIP_PX = 12;
const AUTO_HIDE_MS = 1200;

type Axis = "horizontal" | "vertical";

interface CanvasScrollbarsProps {
  /** Lowest reachable flow point — CanvasAdapter's translateExtent top-left. */
  extentMin?: { x: number; y: number };
}

/**
 * Content-aware overlay scrollbars (Milanote-style). Rendered as a ReactFlow
 * child, so the bars sit inside the canvas element — never over the right rail
 * or the unsorted panel. A bar exists only while content extends beyond the
 * viewport on its axis. Bounds come from the store's node list (positions +
 * sizes), never the DOM, so culled (`onlyRenderVisibleElements`) cards count.
 */
export function CanvasScrollbars({ extentMin = ORIGIN }: CanvasScrollbarsProps) {
  const nodes = useStore((s) => s.nodes);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const viewport = useViewport();
  const { getNodesBounds, setViewport, getViewport } = useReactFlow();

  // Recomputed only when the node list changes (a drag, an edit, a load), not
  // on pan/zoom; O(n) over the store's lookup — cheap at 1 000 cards.
  const content = useMemo(() => (nodes.length > 0 ? getNodesBounds(nodes) : null), [nodes, getNodesBounds]);

  const geometry = computeScrollbars({
    content,
    viewport,
    width,
    height,
    extentMin,
    minThumb: MIN_THUMB_PX,
    corner: STRIP_PX,
  });

  // Auto-hide: visible for AUTO_HIDE_MS after the last viewport change.
  const [recentlyMoved, setRecentlyMoved] = useState(true);
  const [hovered, setHovered] = useState<Axis | null>(null);
  const [dragging, setDragging] = useState<Axis | null>(null);
  const viewportKey = `${viewport.x}|${viewport.y}|${viewport.zoom}`;
  const [shownFor, setShownFor] = useState(viewportKey);
  if (shownFor !== viewportKey) {
    // Adjust-state-during-render: a viewport change shows the bars again.
    setShownFor(viewportKey);
    setRecentlyMoved(true);
  }
  useEffect(() => {
    const timer = setTimeout(() => setRecentlyMoved(false), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [viewportKey]);

  const dragRef = useRef<{
    axis: Axis;
    pointerId: number;
    startClient: number;
    startViewMin: number;
    frozen: AxisGeometry;
    viewSize: number;
    trackLength: number;
  } | null>(null);

  const applyViewMin = (axis: Axis, viewMin: number) => {
    const current = getViewport();
    const translate = viewMinToTranslate(viewMin, current.zoom);
    void setViewport(
      axis === "horizontal"
        ? { x: translate, y: current.y, zoom: current.zoom }
        : { x: current.x, y: translate, zoom: current.zoom },
    );
  };

  const onThumbPointerDown = (axis: Axis) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const geo = geometry[axis];
    const horizontal = axis === "horizontal";
    dragRef.current = {
      axis,
      pointerId: event.pointerId,
      startClient: horizontal ? event.clientX : event.clientY,
      startViewMin: horizontal ? geometry.view.x : geometry.view.y,
      frozen: geo,
      viewSize: horizontal ? geometry.view.width : geometry.view.height,
      trackLength: geo.trackLength,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(axis);
  };

  const onThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const client = drag.axis === "horizontal" ? event.clientX : event.clientY;
    applyViewMin(
      drag.axis,
      thumbDragToViewMin(drag.frozen, drag.startViewMin, drag.viewSize, drag.trackLength, client - drag.startClient),
    );
  };

  const endThumbDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDragging(null);
  };

  const onTrackPointerDown = (axis: Axis) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const geo = geometry[axis];
    const rect = event.currentTarget.getBoundingClientRect();
    const horizontal = axis === "horizontal";
    const clickPx = horizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const viewMin = horizontal ? geometry.view.x : geometry.view.y;
    const viewSize = horizontal ? geometry.view.width : geometry.view.height;
    applyViewMin(axis, pageViewMin(geo, viewMin, viewSize, pageDirection(geo, clickPx)));
  };

  // The strips live outside React Flow's zoom pane, so a wheel over them would
  // be lost. Hand it to the pane unchanged: the bars never swallow a scroll.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const forward = (event: WheelEvent) => {
      const pane = root.closest(".react-flow")?.querySelector(".react-flow__pane");
      if (!pane) return;
      event.preventDefault();
      pane.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaZ: event.deltaZ,
          deltaMode: event.deltaMode,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    root.addEventListener("wheel", forward, { passive: false });
    return () => root.removeEventListener("wheel", forward);
  }, []);

  const renderBar = (axis: Axis) => {
    const geo = geometry[axis];
    if (!geo.visible) return null;
    const horizontal = axis === "horizontal";
    const active = recentlyMoved || hovered === axis || dragging === axis;
    return (
      <div
        key={axis}
        className={`canvas-scrollbar canvas-scrollbar--${axis}`}
        data-testid={`canvas-scrollbar-${axis}`}
        data-active={active ? "true" : "false"}
        data-dragging={dragging === axis ? "true" : undefined}
        style={horizontal ? { width: geo.trackLength } : { height: geo.trackLength }}
        onPointerDown={onTrackPointerDown(axis)}
        onPointerEnter={() => setHovered(axis)}
        onPointerLeave={() => setHovered((h) => (h === axis ? null : h))}
        aria-hidden="true"
      >
        <div
          className="canvas-scrollbar__thumb"
          data-testid={`canvas-scrollbar-${axis}-thumb`}
          style={
            horizontal
              ? { width: geo.thumbLength, transform: `translateX(${geo.thumbOffset}px)` }
              : { height: geo.thumbLength, transform: `translateY(${geo.thumbOffset}px)` }
          }
          onPointerDown={onThumbPointerDown(axis)}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endThumbDrag}
          onPointerCancel={endThumbDrag}
        />
      </div>
    );
  };

  return (
    <div ref={rootRef} className="canvas-scrollbars">
      {renderBar("horizontal")}
      {renderBar("vertical")}
    </div>
  );
}

const ORIGIN = { x: 0, y: 0 };
