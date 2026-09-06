import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";

const names = [
  "note",
  "link",
  "board",
  "image",
  "arrow-left",
  "search",
  "undo",
  "redo",
  "bookmark",
] as const;

describe("Icon", () => {
  it.each(names)("renders %s as a 24px svg icon", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");

    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("stroke-width", "1.7");
    expect(svg).toHaveAttribute("stroke-linecap", "round");
    expect(svg).toHaveAttribute("stroke-linejoin", "round");
    expect(svg?.querySelectorAll("path, circle, line, polyline, rect, ellipse, polygon").length).toBeGreaterThan(0);
  });

  it("exposes an accessible label when provided", () => {
    render(<Icon name="search" label="Search" />);

    expect(screen.getByRole("img", { name: "Search" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });
});
