import { describe, expect, it } from "vitest";
import { wheelScrollsInside } from "./inner-scroll";

describe("wheelScrollsInside", () => {
  const box = (scrollTop: number) => ({ scrollTop, scrollHeight: 2000, clientHeight: 720 });

  it("scrolls the text while there is text left that way", () => {
    expect(wheelScrollsInside(box(0), 100)).toBe(true);
    expect(wheelScrollsInside(box(500), -100)).toBe(true);
  });

  it("hands the wheel back to the canvas at the edges", () => {
    expect(wheelScrollsInside(box(0), -100)).toBe(false);
    expect(wheelScrollsInside(box(1280), 100)).toBe(false);
  });

  it("never claims the wheel for a note without inner scroll", () => {
    expect(wheelScrollsInside({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }, 100)).toBe(false);
  });
});
