import { describe, expect, it } from "vitest";
import type { CanvasCard, CanvasFrame } from "./canvas-types";
import { groupMembers, isInsideGroup, overlapsPartially } from "./group-membership";

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

describe("overlapsPartially", () => {
  const a: CanvasFrame = { x: 0, y: 0, width: 400, height: 300 };

  it("is true when the frames share area but neither contains the other", () => {
    expect(overlapsPartially(a, { x: 300, y: 200, width: 400, height: 300 })).toBe(true);
    expect(overlapsPartially({ x: 300, y: 200, width: 400, height: 300 }, a)).toBe(true);
  });

  it("is false for nesting in either direction and for identical frames", () => {
    expect(overlapsPartially(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(false);
    expect(overlapsPartially({ x: 50, y: 50, width: 100, height: 100 }, a)).toBe(false);
    expect(overlapsPartially(a, { ...a })).toBe(false);
  });

  it("is false for frames that only touch or lie apart", () => {
    expect(overlapsPartially(a, { x: 400, y: 0, width: 100, height: 100 })).toBe(false);
    expect(overlapsPartially(a, { x: 0, y: 300, width: 100, height: 100 })).toBe(false);
    expect(overlapsPartially(a, { x: 900, y: 900, width: 100, height: 100 })).toBe(false);
  });
});

describe("groupMembers with overlapping groups", () => {
  // Розовая (0,0 600×400) наехала на серую (400,100 600×500): общая область
  // x 400–600, y 100–400. Заметка `shared` лежит в обеих, `pink-only` — только
  // в розовой, `gray-only` — только в серой.
  const cards: CanvasCard[] = [
    card("pink", "group", { x: 0, y: 0, width: 600, height: 400 }),
    card("gray", "group", { x: 400, y: 100, width: 600, height: 500 }),
    card("pink-only", "note", { x: 50, y: 50, width: 200, height: 100 }),
    card("shared", "note", { x: 420, y: 150, width: 150, height: 100 }),
    card("gray-only", "note", { x: 700, y: 200, width: 200, height: 100 }),
  ];

  it("a card inside two partially overlapping groups moves with neither", () => {
    expect(groupMembers("pink", cards)).toEqual(["pink-only"]);
    expect(groupMembers("gray", cards)).toEqual(["gray-only"]);
  });

  it("a nested group does not contest the cards of the group around it", () => {
    const nested: CanvasCard[] = [
      card("outer", "group", group),
      card("inner", "group", { x: 120, y: 120, width: 200, height: 150 }),
      card("in-inner", "note", { x: 140, y: 140, width: 100, height: 50 }),
      card("in-outer", "note", { x: 350, y: 300, width: 100, height: 50 }),
    ];
    expect(groupMembers("outer", nested)).toEqual(["inner", "in-inner", "in-outer"]);
    expect(groupMembers("inner", nested)).toEqual(["in-inner"]);
  });

  it("a nested group's card is still contested by a third group that overlaps the inner one partially", () => {
    const mixed: CanvasCard[] = [
      card("outer", "group", group),
      card("inner", "group", { x: 120, y: 120, width: 200, height: 150 }),
      card("third", "group", { x: 250, y: 200, width: 400, height: 300 }),
      card("in-both", "note", { x: 260, y: 210, width: 50, height: 50 }),
    ];
    // Для внешней группы `third` — лишь частичный сосед, карточка спорная.
    expect(groupMembers("outer", mixed)).toEqual(["inner"]);
    expect(groupMembers("inner", mixed)).toEqual([]);
    expect(groupMembers("third", mixed)).toEqual([]);
  });
});
