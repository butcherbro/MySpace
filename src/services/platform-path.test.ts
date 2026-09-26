import { describe, expect, it } from "vitest";
import { fileNameFromPath, isWindowsAbsolutePath, stripWrappingQuotes } from "./platform-path";

describe("fileNameFromPath", () => {
  it("takes the last segment of a posix path", () => {
    expect(fileNameFromPath("/Users/bro/Docs/report.pdf")).toBe("report.pdf");
  });

  it("takes the last segment of a Windows drive path", () => {
    expect(fileNameFromPath("C:\\Users\\bro\\Docs\\report.pdf")).toBe("report.pdf");
  });

  it("takes the last segment of a UNC path", () => {
    expect(fileNameFromPath("\\\\server\\share\\team\\notes.md")).toBe("notes.md");
  });

  it("handles mixed separators and trailing separators", () => {
    expect(fileNameFromPath("C:/Users/bro\\Docs\\")).toBe("Docs");
    expect(fileNameFromPath("/Users/bro/Docs/")).toBe("Docs");
  });

  it("returns the input for a bare name or a root", () => {
    expect(fileNameFromPath("file.txt")).toBe("file.txt");
    expect(fileNameFromPath("/")).toBe("/");
  });
});

describe("isWindowsAbsolutePath", () => {
  it("accepts drive and UNC paths", () => {
    expect(isWindowsAbsolutePath("C:\\Users\\bro")).toBe(true);
    expect(isWindowsAbsolutePath("d:/data")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\dir")).toBe(true);
  });

  it("rejects relative, posix and non-path text", () => {
    expect(isWindowsAbsolutePath("C:relative")).toBe(false);
    expect(isWindowsAbsolutePath("/Users/bro")).toBe(false);
    expect(isWindowsAbsolutePath("\\\\server")).toBe(false);
    expect(isWindowsAbsolutePath("https://example.com")).toBe(false);
  });
});

describe("stripWrappingQuotes", () => {
  it("strips one surrounding pair only", () => {
    expect(stripWrappingQuotes('"C:\\Users\\x\\a.txt"')).toBe("C:\\Users\\x\\a.txt");
    expect(stripWrappingQuotes('"')).toBe('"');
    expect(stripWrappingQuotes('say "hi"')).toBe('say "hi"');
  });
});
