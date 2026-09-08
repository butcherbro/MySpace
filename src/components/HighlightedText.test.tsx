import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HighlightedText } from "./HighlightedText";

function marks(text: string, query: string): HTMLElement[] {
  const { container } = render(<HighlightedText text={text} query={query} />);
  return Array.from(container.querySelectorAll("mark"));
}

function rendered(text: string, query: string): string {
  const { container } = render(<HighlightedText text={text} query={query} />);
  return container.textContent ?? "";
}

describe("HighlightedText", () => {
  it("highlights a single match", () => {
    const list = marks("ship the rocket", "rocket");
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe("rocket");
    expect(rendered("ship the rocket", "rocket")).toBe("ship the rocket");
  });

  it("highlights all matches", () => {
    expect(marks("rocket and rocket", "rocket")).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    const list = marks("Ship the Rocket", "ROCKET");
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe("Rocket");
  });

  it("supports cyrillic case-insensitively", () => {
    const list = marks("привет мир", "Мир");
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe("мир");
  });

  it("treats the query as literal text, not a regex", () => {
    const list = marks("a.b value", "a.b");
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe("a.b");
  });

  it("renders unchanged when the query is empty", () => {
    expect(marks("hello world", "")).toHaveLength(0);
    expect(rendered("hello world", "")).toBe("hello world");
  });

  it("renders unchanged when there is no match", () => {
    expect(marks("hello world", "zzz")).toHaveLength(0);
    expect(rendered("hello world", "zzz")).toBe("hello world");
  });
});