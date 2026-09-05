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
      boardRevision: 1,
      title: "Books",
      colorToken: "terracotta",
      symbol: null,
      childBoardCount: 2,
      childCardCount: 5,
      ...overrides,
    },
  };
}

function renderCard(
  p: BoardPortalDto = portal(),
  handlers: { onOpen?: (id: string) => void; onRename?: (id: string, t: string) => void; onContextMenu?: (id: string, x: number, y: number) => void } = {},
) {
  render(
    <BoardPortalCard
      portal={p}
      onOpen={handlers.onOpen ?? vi.fn()}
      onRename={handlers.onRename ?? vi.fn()}
      onContextMenu={handlers.onContextMenu ?? vi.fn()}
    />,
  );
}

describe("BoardPortalCard", () => {
  it("renders title, derived symbol, and child counts", () => {
    renderCard();
    expect(screen.getByText("Books")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument(); // first grapheme
    expect(screen.getByTestId("portal-count")).toHaveTextContent("2 boards · 5 cards");
  });

  it("exposes the board-portal semantic kind", () => {
    renderCard();
    expect(screen.getByTestId("board-portal-card")).toHaveAttribute("data-kind", "board-portal");
  });

  it("uses an explicit symbol when set", () => {
    renderCard(portal({ symbol: "🚀" }));
    expect(screen.getByText("🚀")).toBeInTheDocument();
  });

  it("derives the first grapheme from a symbol-less title (incl. surrogate pairs)", () => {
    renderCard(portal({ title: "📚 Library" }));
    expect(screen.getByText("📚")).toBeInTheDocument();
  });

  it("opens on Enter", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderCard(portal(), { onOpen });

    screen.getByTestId("board-portal-card").focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("board-1");
  });

  it("shows Empty when there are no children", () => {
    renderCard(portal({ childBoardCount: 0, childCardCount: 0 }));
    expect(screen.getByTestId("portal-count")).toHaveTextContent("Empty");
  });

  it("renames inline on double-click of the title", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderCard(portal(), { onRename });

    await user.dblClick(screen.getByText("Books"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Novels{Enter}");
    expect(onRename).toHaveBeenCalledWith("board-1", "Novels");
  });

  it("opens the context menu on right-click", async () => {
    const user = userEvent.setup();
    const onContextMenu = vi.fn();
    renderCard(portal(), { onContextMenu });

    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("board-portal-card") });
    expect(onContextMenu).toHaveBeenCalled();
  });
});
