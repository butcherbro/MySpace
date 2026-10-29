import { describe, expect, it } from "vitest";
import { formatCreatedDate, formatMenuDate, formatShortcut } from "./menu-format";

// Локальное время: помощник форматирует в часовом поясе пользователя.
const at = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).getTime();

describe("formatMenuDate", () => {
  it("writes day, three-letter month and year", () => {
    expect(formatMenuDate(at(2025, 8, 24))).toBe("24 Aug 2025");
    expect(formatMenuDate(at(2025, 9, 5))).toBe("5 Sep 2025");
  });
});

describe("formatCreatedDate", () => {
  it("names only the creation date", () => {
    expect(formatCreatedDate(at(2025, 8, 24))).toBe("Created 24 Aug 2025");
  });
});

describe("formatShortcut", () => {
  it("uses macOS symbols, Shift before Command", () => {
    expect(formatShortcut("Mod+C", "macos")).toBe("⌘C");
    expect(formatShortcut("Mod+Shift+G", "macos")).toBe("⇧⌘G");
  });

  it("spells Ctrl out on Windows and Linux", () => {
    expect(formatShortcut("Mod+C", "windows")).toBe("Ctrl+C");
    expect(formatShortcut("Mod+Shift+G", "linux")).toBe("Ctrl+Shift+G");
  });

  it("shows the Delete key as ⌫ on macOS only", () => {
    expect(formatShortcut("Delete", "macos")).toBe("⌫");
    expect(formatShortcut("Delete", "windows")).toBe("Delete");
  });
});
