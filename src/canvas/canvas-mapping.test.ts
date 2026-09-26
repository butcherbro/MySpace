import { describe, expect, it } from "vitest";
import {
  canvasNodeInputsEqual,
  cardToNodeLike,
  frameIntersectionRatio,
  movedNodeToCard,
  nodeLikeToFrame,
} from "./canvas-mapping";
import type { CanvasCard } from "./canvas-types";

function card(overrides: Partial<CanvasCard> = {}): CanvasCard {
  return {
    id: "c1",
    boardId: "home",
    kind: "note",
    frame: { x: 10, y: 20, width: 200, height: 80 },
    zIndex: 3,
    revision: 1,
    ...overrides,
  };
}

describe("canvas mapping", () => {
  it("rebuilds a folder shortcut node when it turns local, without a revision bump (ADR-0012)", () => {
    const foreign = card({ kind: "filesystem_alias", aliasLocal: false });
    expect(canvasNodeInputsEqual(foreign, { ...foreign })).toBe(true);
    expect(canvasNodeInputsEqual(foreign, { ...foreign, aliasLocal: true })).toBe(false);
  });

  it("maps a card frame to a renderer-neutral node", () => {
    const node = cardToNodeLike(card());
    expect(node).toEqual({
      id: "c1",
      position: { x: 10, y: 20 },
      width: 200,
      height: 80,
      zIndex: 3,
    });
  });

  it("round-trips a node back to a frame", () => {
    const node = cardToNodeLike(card());
    expect(nodeLikeToFrame(node)).toEqual({ x: 10, y: 20, width: 200, height: 80 });
  });

  it("moves a card while preserving size and identity", () => {
    const moved = movedNodeToCard({
      id: "c1",
      position: { x: 99, y: 42 },
      width: 200,
      height: 80,
      zIndex: 3,
    }, card());
    expect(moved.frame).toEqual({ x: 99, y: 42, width: 200, height: 80 });
    expect(moved.kind).toBe("note");
  });

  it("reports full coverage when the smaller frame is inside the larger", () => {
    const big = { x: 0, y: 0, width: 200, height: 120 };
    const small = { x: 40, y: 40, width: 100, height: 60 };
    expect(frameIntersectionRatio(big, small)).toBe(1);
  });

  it("reports zero when frames do not overlap", () => {
    expect(frameIntersectionRatio(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 200, width: 100, height: 100 },
    )).toBe(0);
  });

  it("reports a partial ratio for a wide card barely covering a portal", () => {
    // A 240-wide note whose center is off the portal but which still overlaps it.
    const note = { x: 0, y: 0, width: 240, height: 120 };
    const portal = { x: 180, y: 0, width: 120, height: 112 };
    // Overlap x: [180,240] = 60; y: [0,112] = 112 -> 6720 area.
    // Smaller frame is the portal (120*112 = 13440) -> ratio ~0.5.
    const ratio = frameIntersectionRatio(note, portal);
    expect(ratio).toBeCloseTo(6720 / 13440, 5);
    expect(ratio).toBeGreaterThan(0.25);
  });
});
