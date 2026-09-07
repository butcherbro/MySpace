import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";
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

function renderBar(overrides: Partial<React.ComponentProps<typeof SearchBar>> = {}) {
  const props = {
    query: "res",
    onQueryChange: vi.fn(),
    results,
    loading: false,
    onSelect: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SearchBar {...props} />) };
}

describe("SearchBar", () => {
  it("renders a visible search input", () => {
    renderBar({ query: "", results: [] });
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
  });

  it("shows results with title and board trail when there is a query", () => {
    renderBar();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("ship the rocket")).toBeInTheDocument();
    expect(screen.getByText("Home / Research")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("hides the dropdown for an empty query", () => {
    renderBar({ query: "", results: [] });
    expect(screen.queryByTestId("search-results")).not.toBeInTheDocument();
  });

  it("shows the loading state", () => {
    renderBar({ loading: true, results: [] });
    expect(screen.getByText("Searching…")).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    renderBar({ query: "zzz", results: [] });
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("calls onQueryChange when typing", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ query: "", results: [] });
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "x");
    expect(props.onQueryChange).toHaveBeenCalled();
  });

  it("selects the active result on Enter", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    const input = screen.getByRole("searchbox", { name: "Search" });
    input.focus();
    await user.keyboard("{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[0]);
  });

  it("moves the active result with arrow keys", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    const input = screen.getByRole("searchbox", { name: "Search" });
    input.focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[1]);
  });

  it("clears the query on Escape", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    const input = screen.getByRole("searchbox", { name: "Search" });
    input.focus();
    await user.keyboard("{Escape}");
    expect(props.onQueryChange).toHaveBeenCalledWith("");
  });

  it("selects a result on click", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    await user.click(screen.getByText("Research"));
    expect(props.onSelect).toHaveBeenCalledWith(results[0]);
  });
});