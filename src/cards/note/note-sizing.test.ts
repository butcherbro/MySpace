import { describe, expect, it } from "vitest";
import {
  LONG_TEXT_CHARS,
  NOTE_DEFAULT_WIDTH,
  NOTE_LONG_TEXT_WIDTH,
  NOTE_MAX_HEIGHT,
  autoGrowHeight,
  noteWidthForText,
  widthAfterPaste,
} from "./note-sizing";

const long = "a".repeat(LONG_TEXT_CHARS);

describe("noteWidthForText", () => {
  it("keeps the default width for short or blank text", () => {
    expect(noteWidthForText("")).toBe(NOTE_DEFAULT_WIDTH);
    expect(noteWidthForText("a".repeat(LONG_TEXT_CHARS - 1))).toBe(NOTE_DEFAULT_WIDTH);
  });

  it("starts a long text wide", () => {
    expect(noteWidthForText(long)).toBe(NOTE_LONG_TEXT_WIDTH);
  });

  it("does not count surrounding whitespace", () => {
    expect(noteWidthForText(`  ${"a".repeat(LONG_TEXT_CHARS - 1)}\n\n\n`)).toBe(NOTE_DEFAULT_WIDTH);
  });
});

describe("widthAfterPaste", () => {
  it("widens a narrow note on a long paste", () => {
    expect(widthAfterPaste(240, long)).toBe(NOTE_LONG_TEXT_WIDTH);
  });

  it("never narrows a wider note", () => {
    expect(widthAfterPaste(700, long)).toBe(700);
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

  it("caps at the backend's height limit", () => {
    expect(autoGrowHeight(9000, 5000)).toBe(NOTE_MAX_HEIGHT);
  });

  it("returns null once the card already sits at the cap", () => {
    expect(autoGrowHeight(NOTE_MAX_HEIGHT, 5000)).toBeNull();
  });
});
