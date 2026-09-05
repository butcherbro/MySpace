import { describe, expect, it } from "vitest";
import { BoardHistory } from "./board-history";

describe("BoardHistory", () => {
  it("starts on the initial board", () => {
    const h = new BoardHistory("home");
    expect(h.current()).toBe("home");
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
  });

  it("pushes and moves forward", () => {
    const h = new BoardHistory("home");
    h.push("a");
    h.push("b");
    expect(h.current()).toBe("b");
    expect(h.canBack()).toBe(true);
    expect(h.canForward()).toBe(false);
  });

  it("pushing the current board id is a no-op", () => {
    const h = new BoardHistory("home");
    h.push("home");
    expect(h.current()).toBe("home");
    expect(h.canBack()).toBe(false);
    expect(h.canForward()).toBe(false);
  });

  it("back and forward navigate the stack", () => {
    const h = new BoardHistory("home");
    h.push("a");
    h.push("b");

    expect(h.back()).toBe("a");
    expect(h.back()).toBe("home");
    expect(h.back()).toBeNull();
    expect(h.forward()).toBe("a");
  });

  it("pushing after going back truncates forward history", () => {
    const h = new BoardHistory("home");
    h.push("a");
    h.push("b");
    h.back(); // to "a"
    h.push("c"); // replaces "b"
    expect(h.forward()).toBeNull();
    expect(h.current()).toBe("c");
  });
});
