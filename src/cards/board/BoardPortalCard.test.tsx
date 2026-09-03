import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardPortalCard } from "./BoardPortalCard";
import type { BoardPortalDto } from "../../services/workspace-gateway";

function portal(overrides: Partial<BoardPortalDto["target"]> = {}): BoardPortalDto {
  return {
    kind: "board_portal",
    id: "portal-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    target: {
      id: "board-1",
      title: "Books",
      colorToken: "terracotta",
      symbol: null,
      childBoardCount: 2,
      childCardCount: 5,
      ...overrides,
    },
  };
}

describe("BoardPortalCard", () => {
  it("renders title, derived symbol, and child counts", () => {
    render(<BoardPortalCard portal={portal()} onOpen={vi.fn()} />);
    expect(screen.getByText("Books")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument(); // first grapheme of "Books"
    expect(screen.getByTestId("portal-count")).toHaveTextContent("2 boards · 5 cards");
  });

  it("uses an explicit symbol when set", () => {
    render(<BoardPortalCard portal={portal({ symbol: "🚀" })} onOpen={vi.fn()} />);
    expect(screen.getByText("🚀")).toBeInTheDocument();
  });

  it("derives the first grapheme from a symbol-less title (incl. surrogate pairs)", () => {
    render(<BoardPortalCard portal={portal({ title: "📚 Library" })} onOpen={vi.fn()} />);
    expect(screen.getByText("📚")).toBeInTheDocument();
  });

  it("opens on Enter", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<BoardPortalCard portal={portal()} onOpen={onOpen} />);

    screen.getByRole("button").focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("board-1");
  });

  it("shows Empty when there are no children", () => {
    render(
      <BoardPortalCard
        portal={portal({ childBoardCount: 0, childCardCount: 0 })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("portal-count")).toHaveTextContent("Empty");
  });
});
