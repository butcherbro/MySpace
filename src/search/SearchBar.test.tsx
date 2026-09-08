import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./SearchBar";
import type { SearchResultDto } from "../services/workspace-gateway";

const results: SearchResultDto[] = [
  {
    entityId: "n1",
    kind: "note",
    title: "ship the rocket",
    excerpt: null,
    boardId: "home",
    boardTrail: [{ id: "home", title: "Home" }],
    boardColorToken: "ink",
    boardSymbol: null,
    boardCoverAsset: null,
    thumbnailAsset: null,
    createdAt: 0,
  },
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
    boardColorToken: "moss",
    boardSymbol: null,
    boardCoverAsset: null,
    thumbnailAsset: null,
    createdAt: 0,
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
  const utils = render(<SearchBar {...props} />);
  return { props, ...utils };
}

describe("SearchBar", () => {
  it("renders a visible search input", () => {
    renderBar({ query: "", results: [] });
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeInTheDocument();
  });

  it("groups results by board with a header path and count", () => {
    const { container } = renderBar();
    const groups = container.querySelectorAll(".search-bar__group");
    expect(groups).toHaveLength(2);

    const headers = Array.from(container.querySelectorAll(".search-bar__group-title")).map(
      (el) => el.textContent,
    );
    expect(headers).toEqual(["Home", "Research"]);

    const counts = Array.from(container.querySelectorAll(".search-bar__group-count")).map(
      (el) => el.textContent,
    );
    expect(counts).toEqual(["1", "1"]);
  });

  it("highlights matching substrings in titles", () => {
    const { container } = renderBar();
    const marks = Array.from(container.querySelectorAll("mark")).map((el) => el.textContent);
    expect(marks.some((m) => m?.toLowerCase() === "res")).toBe(true);
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
    screen.getByRole("searchbox", { name: "Search" }).focus();
    await user.keyboard("{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[0]);
  });

  it("moves the active result with arrow keys", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    screen.getByRole("searchbox", { name: "Search" }).focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onSelect).toHaveBeenCalledWith(results[1]);
  });

  it("clears the query on Escape", async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    screen.getByRole("searchbox", { name: "Search" }).focus();
    await user.keyboard("{Escape}");
    expect(props.onQueryChange).toHaveBeenCalledWith("");
  });
});