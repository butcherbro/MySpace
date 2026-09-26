import { describe, expect, it } from "vitest";
import {
  axisGeometry,
  clampViewMin,
  computeScrollbars,
  pageDirection,
  pageViewMin,
  thumbDragToViewMin,
  viewMinToTranslate,
  viewportFlowRect,
  type AxisInput,
} from "./scrollbar-geometry";

const base: AxisInput = {
  contentMin: 0,
  contentMax: 2000,
  viewMin: 0,
  viewSize: 1000,
  extentMin: 0,
  trackLength: 1000,
  minThumb: 32,
  epsilon: 1,
};

describe("axisGeometry", () => {
  it("is hidden when the content fits inside the viewport", () => {
    const g = axisGeometry({ ...base, contentMin: 100, contentMax: 900 });
    expect(g.visible).toBe(false);
  });

  it("stays hidden within the one-pixel tolerance", () => {
    expect(axisGeometry({ ...base, contentMin: 0, contentMax: 1000.5 }).visible).toBe(false);
    expect(axisGeometry({ ...base, contentMin: 0, contentMax: 1002 }).visible).toBe(true);
  });

  it("shows when content extends past the far edge", () => {
    const g = axisGeometry(base);
    expect(g.visible).toBe(true);
    expect(g.rangeMin).toBe(0);
    expect(g.rangeMax).toBe(2000);
    expect(g.thumbLength).toBe(500);
    expect(g.thumbOffset).toBe(0);
  });

  it("shows when content lies before the viewport and places the thumb at the end", () => {
    const g = axisGeometry({ ...base, contentMin: 0, contentMax: 500, viewMin: 1000 });
    expect(g.visible).toBe(true);
    expect(g.rangeMin).toBe(0);
    expect(g.rangeMax).toBe(2000);
    expect(g.thumbLength).toBe(500);
    expect(g.thumbOffset).toBe(500);
  });

  it("uses the union of content and viewport", () => {
    // Viewport scrolled past the last card: the range grows to include it.
    const g = axisGeometry({ ...base, contentMin: 200, contentMax: 800, viewMin: 1500 });
    expect(g.rangeMin).toBe(200);
    expect(g.rangeMax).toBe(2500);
    expect(g.thumbLength).toBeCloseTo((1000 / 2300) * 1000);
    expect(g.thumbOffset).toBeCloseTo(1000 - g.thumbLength);
  });

  it("clamps the range minimum to the translate extent", () => {
    const g = axisGeometry({ ...base, contentMin: -300, contentMax: 2000, extentMin: 0 });
    expect(g.rangeMin).toBe(0);
    const free = axisGeometry({ ...base, contentMin: -300, contentMax: 2000, extentMin: Number.NEGATIVE_INFINITY });
    expect(free.rangeMin).toBe(-300);
  });

  it("keeps the thumb at least minThumb long", () => {
    const g = axisGeometry({ ...base, contentMax: 1_000_000 });
    expect(g.thumbLength).toBe(32);
    const mid = axisGeometry({ ...base, contentMax: 1_000_000, viewMin: (1_000_000 - 1000) / 2 });
    expect(mid.thumbOffset).toBeCloseTo((1000 - 32) / 2);
  });

  it("never lets minThumb exceed the track", () => {
    const g = axisGeometry({ ...base, contentMax: 1_000_000, trackLength: 20 });
    expect(g.thumbLength).toBe(20);
    expect(g.thumbOffset).toBe(0);
  });

  it("clamps the thumb offset into the track", () => {
    // A viewport outside the extent (transient) must not push the thumb off the track.
    const g = axisGeometry({ ...base, viewMin: -100 });
    expect(g.thumbOffset).toBe(0);
  });
});

describe("thumb drag", () => {
  const frozen = axisGeometry(base); // range 0..2000, thumb 500, free 500

  it("maps a pointer delta to a viewport delta by scrollable/free", () => {
    expect(thumbDragToViewMin(frozen, 0, 1000, 1000, 250)).toBe(500);
    expect(thumbDragToViewMin(frozen, 0, 1000, 1000, 100)).toBe(200);
  });

  it("clamps to the range on both ends", () => {
    expect(thumbDragToViewMin(frozen, 0, 1000, 1000, 10_000)).toBe(1000);
    expect(thumbDragToViewMin(frozen, 500, 1000, 1000, -10_000)).toBe(0);
  });

  it("does nothing when there is nowhere to scroll", () => {
    const fits = axisGeometry({ ...base, contentMax: 800 });
    expect(thumbDragToViewMin(fits, 0, 1000, 1000, 300)).toBe(0);
  });
});

describe("track paging", () => {
  const g = axisGeometry({ ...base, contentMax: 5000, viewMin: 2000 });

  it("pages toward the click by one viewport", () => {
    expect(pageDirection(g, g.thumbOffset - 5)).toBe(-1);
    expect(pageDirection(g, g.thumbOffset + g.thumbLength + 5)).toBe(1);
    expect(pageViewMin(g, 2000, 1000, 1)).toBe(3000);
    expect(pageViewMin(g, 2000, 1000, -1)).toBe(1000);
  });

  it("clamps a page to the range", () => {
    expect(pageViewMin(g, 3500, 1000, 1)).toBe(4000);
    expect(pageViewMin(g, 500, 1000, -1)).toBe(0);
  });

  it("clampViewMin never goes below rangeMin even when the range is smaller than the view", () => {
    expect(clampViewMin({ rangeMin: 0, rangeMax: 500 }, 200, 1000)).toBe(0);
  });
});

describe("computeScrollbars", () => {
  const input = {
    content: { x: 40, y: 40, width: 10_000, height: 3_000 },
    viewport: { x: 0, y: 0, zoom: 1 },
    width: 1200,
    height: 800,
    extentMin: { x: 0, y: 0 },
    minThumb: 32,
    corner: 12,
  };

  it("converts the viewport to flow space", () => {
    expect(viewportFlowRect({ x: -200, y: -100, zoom: 2 }, 1200, 800)).toEqual({ x: 100, y: 50, width: 600, height: 400 });
    expect(viewMinToTranslate(100, 2)).toBe(-200);
    expect(Object.is(viewMinToTranslate(0, 2), 0)).toBe(true);
  });

  it("shows both bars and reserves the corner", () => {
    const g = computeScrollbars(input);
    expect(g.horizontal.visible).toBe(true);
    expect(g.vertical.visible).toBe(true);
    expect(g.horizontal.trackLength).toBe(1188);
    expect(g.vertical.trackLength).toBe(788);
  });

  it("shows only the axis that overflows", () => {
    const g = computeScrollbars({ ...input, content: { x: 40, y: 40, width: 5000, height: 300 } });
    expect(g.horizontal.visible).toBe(true);
    expect(g.vertical.visible).toBe(false);
    expect(g.horizontal.trackLength).toBe(1200);
  });

  it("hides everything once zoomed out far enough", () => {
    const g = computeScrollbars({ ...input, viewport: { x: 0, y: 0, zoom: 0.1 } });
    expect(g.horizontal.visible).toBe(false);
    expect(g.vertical.visible).toBe(false);
  });

  it("hides everything on an empty board or an unmeasured pane", () => {
    expect(computeScrollbars({ ...input, content: null }).horizontal.visible).toBe(false);
    expect(computeScrollbars({ ...input, width: 0 }).vertical.visible).toBe(false);
  });

  it("scales tolerance with zoom (one screen pixel)", () => {
    // Content ends 0.5 flow px past the view at zoom 1 → hidden; at zoom 4 that is 2 screen px → visible.
    const content = { x: 0, y: 0, width: 1200.5, height: 10 };
    expect(computeScrollbars({ ...input, content }).horizontal.visible).toBe(false);
    const zoomed = { x: 0, y: 0, width: 300.5, height: 10 };
    expect(computeScrollbars({ ...input, content: zoomed, viewport: { x: 0, y: 0, zoom: 4 } }).horizontal.visible).toBe(true);
  });
});
