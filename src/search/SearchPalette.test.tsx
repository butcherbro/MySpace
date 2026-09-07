import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchPalette } from "./SearchPalette";
import type { SearchResultDto } from "../services/workspace-gateway";

const results: SearchResultDto[] = [
  {
    entityId: "b1",
    kind: "board",
    title: "Research",
    excerpt: null,
    boardId: "b1",
    boardTrail: [
      { id: "home", title: "Home" },
      { id: "b1", title: "Research" },
    ],
  },
  {
    entityId: "n1",
    kind: "note",
    title: "ship the rocket",
    excerpt: null,
    boardId: "home",
    boardTrail: [{ id: "home", title: "Home" }],
  },
];

function renderPalette(overrides: Partial<React.ComponentProps<typeof SearchPalette>> = {}) {
  const props = {
    query: "res",
    onQueryChange: vi.fn(),
    results,
    loading: false,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SearchPalette {...props} />) };
}

describe("SearchPalette", () => {
  it("renders results with title and board trail", () => {
    renderPalette();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("ship the rocket")).toBeInTheDocument();
    expect(screen.getByText("Home / Research")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("shows the loading state", () => {
    renderPalette({ loading: true, results: [] });
    expect(screen.getByText("Searching…")).toBeInTheDocument();
  });

  it("shows the empty state only when a query is present", () => {
    renderPalette({ query: "zzz", results: [] });
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("calls onQueryChange when typing", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "x");
    expect(props.onQueryChange).toHaveBeenCalled();
  });

  it("selects the active result on Enter", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await user.keyboard("{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[0]);
  });

  it("moves the active result with arrow keys", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[1]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("selects a result on click", async () => {
    const user = userEvent.setup();
    const { props } = renderPalette();
    await user.click(screen.getByText("Research"));
    expect(props.onSelect).toHaveBeenCalledWith(results[0]);
  });
});