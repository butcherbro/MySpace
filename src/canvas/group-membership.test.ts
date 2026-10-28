import { describe, expect, it } from "vitest";
import type { CanvasCard, CanvasFrame } from "./canvas-types";
import { groupMembers, isInsideGroup } from "./group-membership";

const group: CanvasFrame = { x: 100, y: 100, width: 400, height: 300 };

function card(id: string, kind: CanvasCard["kind"], frame: CanvasFrame): CanvasCard {
  return { id, boardId: "home", kind, frame, zIndex: 0, revision: 1 };
}

describe("isInsideGroup", () => {
  it("is true for a card fully inside the frame", () => {
    expect(isInsideGroup({ x: 150, y: 160, width: 200, height: 100 }, group)).toBe(true);
  });

  it("is true for a card touching the borders from inside", () => {
    expect(isInsideGroup({ x: 100, y: 100, width: 400, height: 300 }, group)).toBe(true);
    expect(isInsideGroup({ x: 100, y: 300, width: 120, height: 100 }, group)).toBe(true);
  });

  it("is false when any one edge is outside, even by one pixel", () => {
    expect(isInsideGroup({ x: 99, y: 150, width: 200, height: 100 }, group)).toBe(false);
    expect(isInsideGroup({ x: 150, y: 99, width: 200, height: 100 }, group)).toBe(false);
    expect(isInsideGroup({ x: 301, y: 150, width: 200, height: 100 }, group)).toBe(false);
    expect(isInsideGroup({ x: 150, y: 301, width: 200, height: 100 }, group)).toBe(false);
  });

  it("is false for a card that only overlaps the frame", () => {
    expect(isInsideGroup({ x: 450, y: 150, width: 200, height: 100 }, group)).toBe(false);
  });
});

describe("groupMembers", () => {
  const cards: CanvasCard[] = [
    card("outer", "group", group),
    card("inside", "note", { x: 120, y: 140, width: 200, height: 80 }),
    card("border", "image", { x: 380, y: 300, width: 120, height: 100 }),
    card("nested", "group", { x: 110, y: 240, width: 250, height: 150 }),
    card("in-nested", "note", { x: 130, y: 280, width: 150, height: 60 }),
    card("crossing", "note", { x: 450, y: 120, width: 200, height: 80 }),
    card("outside", "note", { x: 700, y: 120, width: 200, height: 80 }),
  ];

  it("lists every card inside, nested groups and their members included, never the group itself", () => {
    expect(groupMembers("outer", cards)).toEqual(["inside", "border", "nested", "in-nested"]);
  });

  it("a nested group's members are only what lies inside its own frame", () => {
    expect(groupMembers("nested", cards)).toEqual(["in-nested"]);
  });

  it("is empty for an unknown id or a card that is not a group", () => {
    expect(groupMembers("missing", cards)).toEqual([]);
    expect(groupMembers("inside", cards)).toEqual([]);
  });
});
