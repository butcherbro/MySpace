import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardShortcutCard } from "./BoardShortcutCard";
import type { BoardShortcutDto } from "../../services/workspace-gateway";

function shortcut(overrides: Partial<NonNullable<BoardShortcutDto["target"]>> = {}): BoardShortcutDto {
  return {
    kind: "board_shortcut",
    id: "shortcut-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    targetBoardId: "board-1",
    target: {
      id: "board-1",
      boardRevision: 1,
      title: "Books",
      colorToken: "terracotta",
      symbol: null,
      coverAsset: null,
      ...overrides,
    },
  };
}

function brokenShortcut(): BoardShortcutDto {
  return {
    kind: "board_shortcut",
    id: "shortcut-broken",
    boardId: "home",
    frame: { x: 0, y: 0, width: 120, height: 112 },
    zIndex: 0,
    revision: 1,
    targetBoardId: "board-gone",
    target: null,
  };
}

describe("BoardShortcutCard", () => {
  it("renders the target board's live identity (title) and the alias badge icon", () => {
    render(<BoardShortcutCard shortcut={shortcut()} onOpen={vi.fn()} onContextMenu={vi.fn()} />);
    expect(screen.getByText("Books")).toBeInTheDocument();
    const card = screen.getByTestId("board-shortcut-card");
    expect(card).toHaveAttribute("data-kind", "board-shortcut");
    expect(card).toHaveAttribute("data-broken", "false");
    // The corner arrow badge is present (Finder-alias style marker).
    expect(card.querySelector(".board-shortcut-card__badge")).toBeInTheDocument();
  });

  it("double-clicking the tile navigates to the target board", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<BoardShortcutCard shortcut={shortcut()} onOpen={onOpen} onContextMenu={vi.fn()} />);
    const tile = screen.getByTestId("board-shortcut-card").querySelector(".board-portal-card__tile");
    await user.dblClick(tile as Element);
    expect(onOpen).toHaveBeenCalledWith("board-1");
  });

  it("Enter also navigates to the target board", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<BoardShortcutCard shortcut={shortcut()} onOpen={onOpen} onContextMenu={vi.fn()} />);
    screen.getByTestId("board-shortcut-card").focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("board-1");
  });

  it("right-click opens the context menu for this card's id", async () => {
    const user = userEvent.setup();
    const onContextMenu = vi.fn();
    render(<BoardShortcutCard shortcut={shortcut()} onOpen={vi.fn()} onContextMenu={onContextMenu} />);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByTestId("board-shortcut-card") });
    expect(onContextMenu).toHaveBeenCalledWith("shortcut-1", expect.any(Number), expect.any(Number));
  });

  it("renders a broken tile and does not navigate when the target is gone (todo.md №17)", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<BoardShortcutCard shortcut={brokenShortcut()} onOpen={onOpen} onContextMenu={vi.fn()} />);
    const card = screen.getByTestId("board-shortcut-card");
    expect(card).toHaveAttribute("data-broken", "true");
    expect(screen.getByText("Board is in Trash")).toBeInTheDocument();
    expect(screen.getByTestId("board-shortcut-broken-tile")).toBeInTheDocument();
    await user.dblClick(card);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
