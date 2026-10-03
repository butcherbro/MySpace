import { describe, expect, it } from "vitest";
import {
  LONG_TEXT_CHARS,
  NOTE_AUTO_MAX_HEIGHT,
  NOTE_LONG_TEXT_WIDTH,
  NOTE_DEFAULT_WIDTH,
  NOTE_MAX_HEIGHT,
  NOTE_MAX_WIDTH,
  autoGrowHeight,
  clampNoteSize,
  noteWidthForText,
  widthAfterPaste,
} from "./note-sizing";

const chars = (n: number) => "a".repeat(n);

describe("noteWidthForText", () => {
  it("keeps the default width for short or blank text", () => {
    expect(noteWidthForText("")).toBe(NOTE_DEFAULT_WIDTH);
    expect(noteWidthForText(chars(LONG_TEXT_CHARS - 1))).toBe(NOTE_DEFAULT_WIDTH);
  });

  it("gives any long text one standard, readable width", () => {
    expect(noteWidthForText(chars(LONG_TEXT_CHARS))).toBe(NOTE_LONG_TEXT_WIDTH);
    expect(noteWidthForText(chars(100_000))).toBe(NOTE_LONG_TEXT_WIDTH);
  });

  it("does not count surrounding whitespace", () => {
    expect(noteWidthForText(`  ${chars(LONG_TEXT_CHARS - 1)}\n\n\n`)).toBe(NOTE_DEFAULT_WIDTH);
  });
});

describe("widthAfterPaste", () => {
  it("widens a narrow note on a long paste", () => {
    expect(widthAfterPaste(240, chars(2000))).toBe(NOTE_LONG_TEXT_WIDTH);
  });

  it("never narrows a wider note", () => {
    expect(widthAfterPaste(700, chars(2000))).toBe(700);
  });

  it("leaves the width alone for a short paste", () => {
    expect(widthAfterPaste(240, "hello")).toBe(240);
  });
});

describe("autoGrowHeight", () => {
  it("grows by the overflow, rounded up", () => {
    expect(autoGrowHeight(120, 40.2)).toBe(161);
  });

  it("returns null without overflow", () => {
    expect(autoGrowHeight(120, 0)).toBeNull();
    expect(autoGrowHeight(120, -5)).toBeNull();
  });

  it("stops at about one screen", () => {
    expect(autoGrowHeight(120, 5000)).toBe(NOTE_AUTO_MAX_HEIGHT);
    expect(autoGrowHeight(NOTE_AUTO_MAX_HEIGHT, 5000)).toBeNull();
  });

  it("never shrinks a card the user dragged taller than the cap", () => {
    expect(autoGrowHeight(2000, 500)).toBeNull();
  });
});

describe("clampNoteSize", () => {
  it("keeps a manual resize inside the backend's frame bounds", () => {
    expect(clampNoteSize(5000, 50_000)).toEqual({ width: NOTE_MAX_WIDTH, height: NOTE_MAX_HEIGHT });
    expect(clampNoteSize(10, 10)).toEqual({ width: 120, height: 48 });
    expect(clampNoteSize(500, 900)).toEqual({ width: 500, height: 900 });
  });
});
