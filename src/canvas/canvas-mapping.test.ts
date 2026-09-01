import { describe, expect, it } from "vitest";
import {
  cardToNodeLike,
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
});
