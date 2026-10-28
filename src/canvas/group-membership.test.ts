import { describe, expect, it } from "vitest";
import type { CanvasCard, CanvasFrame } from "./canvas-types";
import { descendantGroupIds, groupForDrop, groupMembers, isInsideGroup } from "./group-membership";

const group: CanvasFrame = { x: 100, y: 100, width: 400, height: 300 };

function card(id: string, kind: CanvasCard["kind"], frame: CanvasFrame, groupId: string | null = null): CanvasCard {
  return { id, boardId: "home", kind, frame, zIndex: 0, revision: 1, groupId };
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
  const far: CanvasFrame = { x: 2000, y: 2000, width: 100, height: 100 };
  const cards: CanvasCard[] = [
    card("outer", "group", group),
    card("member", "note", far, "outer"),
    card("nested", "group", far, "outer"),
    card("in-nested", "note", far, "nested"),
    // Лежит внутри рамки, но не член: геометрия состав не задаёт.
    card("covered", "note", { x: 120, y: 140, width: 200, height: 80 }),
    card("elsewhere", "note", far, "other"),
  ];

  it("lists stored members and, transitively, the members of member groups, in cards order", () => {
    expect(groupMembers("outer", cards)).toEqual(["member", "nested", "in-nested"]);
  });

  it("ignores geometry: a card lying inside the frame without groupId is not a member", () => {
    expect(groupMembers("outer", cards)).not.toContain("covered");
  });

  it("a nested group lists only its own subtree", () => {
    expect(groupMembers("nested", cards)).toEqual(["in-nested"]);
  });

  it("is empty for an unknown id or a card that is not a group", () => {
    expect(groupMembers("missing", cards)).toEqual([]);
    expect(groupMembers("member", cards)).toEqual([]);
  });

  it("terminates on cyclic stored data and never lists the group itself", () => {
    const cyclic = [card("a", "group", far, "b"), card("b", "group", far, "a"), card("n", "note", far, "b")];
    expect(groupMembers("a", cyclic)).toEqual(["b", "n"]);
    expect(groupMembers("b", cyclic)).toEqual(["a", "n"]);
  });
});

describe("descendantGroupIds", () => {
  it("is the group itself plus every group nested under it, not plain members", () => {
    const far: CanvasFrame = { x: 0, y: 0, width: 10, height: 10 };
    const cards = [
      card("outer", "group", far),
      card("mid", "group", far, "outer"),
      card("inner", "group", far, "mid"),
      card("note", "note", far, "inner"),
      card("sibling", "group", far),
    ];
    expect(descendantGroupIds("outer", cards)).toEqual(new Set(["outer", "mid", "inner"]));
    expect(descendantGroupIds("inner", cards)).toEqual(new Set(["inner"]));
  });
});

describe("groupForDrop", () => {
  const big = card("big", "group", { x: 0, y: 0, width: 1000, height: 800 });
  const small = card("small", "group", { x: 100, y: 100, width: 400, height: 300 });
  const twin = card("twin", "group", { x: 100, y: 100, width: 400, height: 300 });
  const inSmall: CanvasFrame = { x: 150, y: 150, width: 100, height: 100 };

  it("picks the smallest frame that contains the whole card", () => {
    expect(groupForDrop(inSmall, [big, small], new Set())).toBe("small");
    expect(groupForDrop({ x: 600, y: 150, width: 100, height: 100 }, [big, small], new Set())).toBe("big");
  });

  it("breaks an area tie by cards order", () => {
    expect(groupForDrop(inSmall, [big, twin, small], new Set())).toBe("twin");
    expect(groupForDrop(inSmall, [big, small, twin], new Set())).toBe("small");
  });

  it("is null when no frame contains the whole card", () => {
    expect(groupForDrop({ x: 950, y: 50, width: 100, height: 100 }, [big, small], new Set())).toBeNull();
  });

  it("skips excluded groups and non-group cards", () => {
    const note = card("note", "note", { x: 0, y: 0, width: 2000, height: 2000 });
    expect(groupForDrop(inSmall, [note, big, small], new Set(["small"]))).toBe("big");
    expect(groupForDrop(inSmall, [note, big, small], new Set(["small", "big"]))).toBeNull();
  });
});
