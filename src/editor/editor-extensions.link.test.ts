import { describe, expect, it } from "vitest";
import { createEditorExtensions } from "./editor-extensions";

describe("editor-extensions link config", () => {
  it("includes a Link extension with autolink and openOnClick enabled", () => {
    const exts = createEditorExtensions();
    const link = exts.find((e) => e.name === "link");
    expect(link).toBeDefined();

    // Narrow the union type: the extension is present iff its name is "link".
    if (link?.name !== "link") throw new Error("link extension missing");
    const options = link.options as {
      autolink?: boolean;
      linkOnPaste?: boolean;
      openOnClick?: boolean;
      shouldAutoLink?: (url: string) => boolean;
    };

    expect(options.autolink).toBe(true);
    expect(options.linkOnPaste).toBe(true);
    expect(options.openOnClick).toBe(true);
    expect(typeof options.shouldAutoLink).toBe("function");
    // A bare https URL must pass the autolink predicate.
    expect(options.shouldAutoLink?.("https://example.com")).toBe(true);
  });
});
