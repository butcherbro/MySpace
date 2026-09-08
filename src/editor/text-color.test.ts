import { describe, expect, it } from "vitest";
import { TEXT_COLOR_IDS, TEXT_COLOR_OPTIONS, TextColor } from "./text-color";

describe("TextColor mark", () => {
  it("exposes the six semantic presets in order", () => {
    expect(TEXT_COLOR_IDS).toEqual(["default", "blue", "green", "orange", "red", "gray"]);
    expect(TEXT_COLOR_OPTIONS.map((o) => o.id)).toEqual(TEXT_COLOR_IDS);
  });

  it("renders a semantic class for a non-default color", () => {
    const renderHTML = TextColor.config.renderHTML as unknown as (props: {
      HTMLAttributes: Record<string, unknown>;
    }) => [string, Record<string, unknown>, number];

    const [tag, attrs] = renderHTML({ HTMLAttributes: { "data-color": "blue" } });
    expect(tag).toBe("span");
    expect((attrs.class as string).split(" ")).toContain("text-color--blue");
  });

  it("parses the color back from the data-color attribute", () => {
    const addAttributes = TextColor.config.addAttributes as unknown as () => {
      color: { parseHTML: (el: HTMLElement) => string | null };
    };
    const { color } = addAttributes();
    expect(color.parseHTML({ getAttribute: () => "red" } as unknown as HTMLElement)).toBe("red");
  });
});