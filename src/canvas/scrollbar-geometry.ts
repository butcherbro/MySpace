// Pure geometry for the canvas overlay scrollbars (CanvasScrollbars.tsx).
//
// Everything here works in FLOW coordinates (board space) for one axis at a
// time, plus track/thumb lengths in screen pixels. The viewport rect in flow
// space is `{-x/zoom, -y/zoom, width/zoom, height/zoom}` for a React Flow
// transform `[x, y, zoom]`.
//
// Rules (Milanote-style):
// - A bar exists only while content sticks out of the viewport on its axis.
// - The scrollable range is union(content, viewport), its minimum clamped to
//   the translate extent (the board origin, 0) — the viewport can never go
//   there anyway, so the bar must not pretend it can.
// - Thumb length = viewport / range × track, never shorter than `minThumb`.
// - Thumb offset = the viewport's position inside the range.

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AxisInput {
  /** Content extent on this axis (flow units). */
  contentMin: number;
  contentMax: number;
  /** Viewport start and size on this axis (flow units). */
  viewMin: number;
  viewSize: number;
  /** Lowest reachable flow coordinate (translateExtent), -Infinity for none. */
  extentMin: number;
  /** Track length in screen pixels. */
  trackLength: number;
  /** Minimum thumb length in screen pixels. */
  minThumb: number;
  /** Tolerance in flow units before content counts as "off-screen". */
  epsilon: number;
}

export interface AxisGeometry {
  visible: boolean;
  rangeMin: number;
  rangeMax: number;
  /** Thumb length and offset along the track, in screen pixels. */
  thumbLength: number;
  thumbOffset: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function axisOverflows(input: Pick<AxisInput, "contentMin" | "contentMax" | "viewMin" | "viewSize" | "epsilon">): boolean {
  const { contentMin, contentMax, viewMin, viewSize, epsilon } = input;
  return contentMin < viewMin - epsilon || contentMax > viewMin + viewSize + epsilon;
}

export function axisGeometry(input: AxisInput): AxisGeometry {
  const { contentMin, contentMax, viewMin, viewSize, extentMin, trackLength, minThumb } = input;
  const visible = axisOverflows(input);
  const rangeMin = Math.max(Math.min(contentMin, viewMin), extentMin);
  const rangeMax = Math.max(contentMax, viewMin + viewSize, rangeMin + viewSize);
  const rangeSize = rangeMax - rangeMin;
  const track = Math.max(0, trackLength);
  const thumbLength =
    rangeSize > 0 ? clamp((viewSize / rangeSize) * track, Math.min(minThumb, track), track) : track;
  const scrollable = rangeSize - viewSize;
  const free = track - thumbLength;
  const thumbOffset = scrollable > 0 && free > 0 ? clamp(((viewMin - rangeMin) / scrollable) * free, 0, free) : 0;
  return { visible, rangeMin, rangeMax, thumbLength, thumbOffset };
}

/** Clamps a viewport start so the viewport stays inside the range. */
export function clampViewMin(axis: Pick<AxisGeometry, "rangeMin" | "rangeMax">, viewMin: number, viewSize: number): number {
  return clamp(viewMin, axis.rangeMin, Math.max(axis.rangeMin, axis.rangeMax - viewSize));
}

/**
 * Thumb drag: a pointer delta of `deltaPx` along the track (measured from the
 * drag start) → the new viewport start in flow units. `axis` is the geometry
 * frozen at drag start, so the range does not shift under the pointer as the
 * viewport (part of the union) moves.
 */
export function thumbDragToViewMin(
  axis: AxisGeometry,
  startViewMin: number,
  viewSize: number,
  trackLength: number,
  deltaPx: number,
): number {
  const scrollable = axis.rangeMax - axis.rangeMin - viewSize;
  const free = trackLength - axis.thumbLength;
  if (scrollable <= 0 || free <= 0) return clampViewMin(axis, startViewMin, viewSize);
  return clampViewMin(axis, startViewMin + (deltaPx * scrollable) / free, viewSize);
}

/** Track click: one viewport page toward the click (`direction` -1 or +1). */
export function pageViewMin(axis: AxisGeometry, viewMin: number, viewSize: number, direction: -1 | 1): number {
  return clampViewMin(axis, viewMin + direction * viewSize, viewSize);
}

/** Which way a track click at `clickPx` pages, relative to the thumb. */
export function pageDirection(axis: AxisGeometry, clickPx: number): -1 | 1 {
  return clickPx < axis.thumbOffset ? -1 : 1;
}

export interface ScrollbarsInput {
  /** Content bounds in flow units, or null for an empty board. */
  content: FlowRect | null;
  /** React Flow viewport. */
  viewport: { x: number; y: number; zoom: number };
  /** Container (pane) size in screen pixels. */
  width: number;
  height: number;
  /** Lowest reachable flow point (translateExtent's top-left). */
  extentMin: { x: number; y: number };
  minThumb: number;
  /** Reserved corner when both bars show, in screen pixels. */
  corner: number;
}

export interface ScrollbarsGeometry {
  view: FlowRect;
  horizontal: AxisGeometry & { trackLength: number };
  vertical: AxisGeometry & { trackLength: number };
}

export function viewportFlowRect(viewport: { x: number; y: number; zoom: number }, width: number, height: number): FlowRect {
  const zoom = viewport.zoom || 1;
  return { x: -viewport.x / zoom, y: -viewport.y / zoom, width: width / zoom, height: height / zoom };
}

/** Screen translate for a viewport start on one axis. */
export function viewMinToTranslate(viewMin: number, zoom: number): number {
  const translate = -viewMin * zoom;
  return translate === 0 ? 0 : translate; // no -0
}

const HIDDEN: AxisGeometry = { visible: false, rangeMin: 0, rangeMax: 0, thumbLength: 0, thumbOffset: 0 };

export function computeScrollbars(input: ScrollbarsInput): ScrollbarsGeometry {
  const { content, viewport, width, height, extentMin, minThumb, corner } = input;
  const view = viewportFlowRect(viewport, width, height);
  if (!content || width <= 0 || height <= 0) {
    return { view, horizontal: { ...HIDDEN, trackLength: 0 }, vertical: { ...HIDDEN, trackLength: 0 } };
  }
  // One screen pixel of tolerance, so sub-pixel rounding never flashes a bar.
  const epsilon = 1 / (viewport.zoom || 1);
  const hVisible = axisOverflows({
    contentMin: content.x,
    contentMax: content.x + content.width,
    viewMin: view.x,
    viewSize: view.width,
    epsilon,
  });
  const vVisible = axisOverflows({
    contentMin: content.y,
    contentMax: content.y + content.height,
    viewMin: view.y,
    viewSize: view.height,
    epsilon,
  });
  const hTrack = Math.max(0, width - (vVisible ? corner : 0));
  const vTrack = Math.max(0, height - (hVisible ? corner : 0));
  const horizontal = axisGeometry({
    contentMin: content.x,
    contentMax: content.x + content.width,
    viewMin: view.x,
    viewSize: view.width,
    extentMin: extentMin.x,
    trackLength: hTrack,
    minThumb,
    epsilon,
  });
  const vertical = axisGeometry({
    contentMin: content.y,
    contentMax: content.y + content.height,
    viewMin: view.y,
    viewSize: view.height,
    extentMin: extentMin.y,
    trackLength: vTrack,
    minThumb,
    epsilon,
  });
  return {
    view,
    horizontal: { ...horizontal, trackLength: hTrack },
    vertical: { ...vertical, trackLength: vTrack },
  };
}
