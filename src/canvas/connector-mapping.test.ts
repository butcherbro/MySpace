import { describe, expect, it } from "vitest";
import { connectorsToEdgeLikes } from "./connector-mapping";
import type { CanvasCard, CanvasConnector } from "./canvas-types";

function card(id: string): CanvasCard {
  return { id, boardId: "home", kind: "note", frame: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0, revision: 1, groupId: null };
}

function connector(id: string, fromCardId: string, toCardId: string): CanvasConnector {
  return { id, fromCardId, toCardId, colorToken: "blue", arrowEnds: "both" };
}

describe("connectorsToEdgeLikes", () => {
  it("maps a connector between two cards on the canvas to an edge from `from` to `to`", () => {
    expect(connectorsToEdgeLikes([connector("c1", "a", "b")], [card("a"), card("b")])).toEqual([
      { id: "c1", source: "a", target: "b", colorToken: "blue", arrowEnds: "both" },
    ]);
  });

  it("drops connectors whose endpoint is not on the canvas (trashed or moved away locally)", () => {
    const connectors = [connector("c1", "a", "b"), connector("c2", "a", "gone"), connector("c3", "gone", "b")];
    expect(connectorsToEdgeLikes(connectors, [card("a"), card("b")]).map((e) => e.id)).toEqual(["c1"]);
  });

  it("never draws a self link", () => {
    expect(connectorsToEdgeLikes([connector("c1", "a", "a")], [card("a")])).toEqual([]);
  });
});
