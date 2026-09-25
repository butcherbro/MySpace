import { describe, expect, it } from "vitest";
import tokens from "./tokens.css?raw";
import global from "./global.css?raw";
import noteEditorCss from "../editor/note-editor.css?raw";
import mainSource from "../main.tsx?raw";

// jsdom does not load fonts or resolve computed font families, so these guard
// the wiring instead; the Playwright typography spec checks the real render.
function declaration(css: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim();
}

describe("bundled typography", () => {
  it("declares Inter Variable first in the UI and text font tokens", () => {
    expect(declaration(tokens, "--font-ui")).toMatch(/^"Inter Variable",/);
    expect(declaration(tokens, "--font-text")).toMatch(/^"Inter Variable",/);
  });

  it("imports the bundled fontsource CSS before the tokens", () => {
    const fontImport = mainSource.indexOf('import "@fontsource-variable/inter"');
    expect(fontImport).toBeGreaterThanOrEqual(0);
    expect(fontImport).toBeLessThan(mainSource.indexOf('import "./styles/tokens.css"'));
  });

  it("uses the 15px / 1.55 note scale", () => {
    expect(declaration(tokens, "--text-note-size")).toBe("15px");
    expect(declaration(tokens, "--text-note-leading")).toBe("1.55");
  });

  it("forces grayscale antialiasing only on macOS", () => {
    const [unscoped, macos] = global.split('html[data-platform="macos"] body');
    expect(unscoped).not.toContain("-webkit-font-smoothing");
    expect(macos).toContain("-webkit-font-smoothing: antialiased");
  });

  it("gives the static note root the same font features as the editor", () => {
    // P1.8 parity: the idle static HTML and the mounted editor must shape text
    // identically, or the note jumps when it enters edit mode.
    const features = [...noteEditorCss.matchAll(/font-feature-settings:\s*([^;]+);/g)].map((m) => m[1]);
    expect(features.length).toBeGreaterThanOrEqual(2);
    expect(new Set(features).size).toBe(1);
  });
});
