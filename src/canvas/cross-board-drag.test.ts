import { describe, expect, it } from "vitest";
import {
  cancelCrossBoardDrag,
  commitCrossBoardDrag,
  createCrossBoardDrag,
  hoverCrossBoardTab,
  moveCrossBoardDrag,
  targetBoardLoaded,
} from "./cross-board-drag";

const ghost = {
  cardId: "note-1",
  kind: "note",
  width: 200,
  height: 80,
  label: "hello",
  revision: 1,
  boardId: "home",
  frame: { x: 0, y: 0, width: 200, height: 80 },
};

describe("cross-board drag state machine", () => {
  it("starts in dragging on the source board", () => {
    const s = createCrossBoardDrag(["note-1"], "home", ghost);
    expect(s.phase).toBe("dragging");
    expect(s.sourceBoardId).toBe("home");
    expect(s.hoverBoardId).toBeNull();
    expect(s.ghostCard).toEqual(ghost);
  });

  it("moving updates the pointer and the board under it", () => {
    let s = createCrossBoardDrag(["note-1"], "home", ghost);
    s = moveCrossBoardDrag(s, { x: 100, y: 200 }, "board-b");
    expect(s.pointer).toEqual({ x: 100, y: 200 });
    expect(s.pointerBoardId).toBe("board-b");
  });

  it("hovering a tab enters loading-target once", () => {
    let s = createCrossBoardDrag(["note-1"], "home", ghost);
    s = hoverCrossBoardTab(s, "board-b");
    expect(s.hoverBoardId).toBe("board-b");
    expect(s.phase).toBe("loading-target");
    // Idempotent: hovering the same tab again does not reset the phase.
    const again = hoverCrossBoardTab(s, "board-b");
    expect(again.phase).toBe("loading-target");
  });

  it("target loaded moves to previewing (ghost)", () => {
    let s = createCrossBoardDrag(["note-1"], "home", ghost);
    s = hoverCrossBoardTab(s, "board-b");
    s = targetBoardLoaded(s);
    expect(s.phase).toBe("previewing");
  });

  it("commit moves to committing; cancel moves to cancelled", () => {
    let s = createCrossBoardDrag(["note-1"], "home", ghost);
    s = hoverCrossBoardTab(s, "board-b");
    s = targetBoardLoaded(s);
    s = commitCrossBoardDrag(s);
    expect(s.phase).toBe("committing");

    const c = cancelCrossBoardDrag(createCrossBoardDrag(["note-1"], "home", ghost));
    expect(c.phase).toBe("cancelled");
  });
});