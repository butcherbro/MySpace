import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QuickBoardsBar } from "./QuickBoardsBar";
import type { QuickBoardDto } from "../services/workspace-gateway";

function qb(boardId: string, title: string, sortOrder: number): QuickBoardDto {
  return { boardId, title, colorToken: "terracotta", sortOrder };
}

describe("QuickBoardsBar", () => {
  it("renders null when empty", () => {
    render(<QuickBoardsBar quickBoards={[]} onOpen={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByTestId("quick-boards")).not.toBeInTheDocument();
  });

  it("renders a drop target when empty but dropActive", () => {
    render(
      <QuickBoardsBar quickBoards={[]} onOpen={vi.fn()} onRemove={vi.fn()} dropActive />,
    );
    expect(screen.getByTestId("quick-boards")).toHaveAttribute("data-quick-boards-drop", "true");
    expect(screen.getByText("Drop to pin")).toBeInTheDocument();
  });

  it("renders a chip per quick board in order", () => {
    render(
      <QuickBoardsBar
        quickBoards={[qb("a", "Books", 0), qb("b", "Notes", 1)]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const chips = screen.getAllByTestId("quick-board");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-board-id", "a");
    expect(chips[1]).toHaveAttribute("data-board-id", "b");
  });

  it("opens a board on click", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <QuickBoardsBar quickBoards={[qb("a", "Books", 0)]} onOpen={onOpen} onRemove={vi.fn()} />,
    );
    await user.click(screen.getByText("Books"));
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("removes a board via the hover affordance", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <QuickBoardsBar quickBoards={[qb("a", "Books", 0)]} onOpen={vi.fn()} onRemove={onRemove} />,
    );
    await user.click(screen.getByRole("button", { name: "Remove quick board Books" }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("shows a drop affordance when dropActive", () => {
    render(
      <QuickBoardsBar
        quickBoards={[qb("a", "Books", 0)]}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        dropActive
      />,
    );
    expect(screen.getByTestId("quick-boards")).toHaveAttribute("data-quick-boards-drop", "true");
  });

  it("collapses overflow beyond the max into an overflow menu", () => {
    const many = Array.from({ length: 10 }, (_, i) => qb(`b${i}`, `Board ${i}`, i));
    render(<QuickBoardsBar quickBoards={many} onOpen={vi.fn()} onRemove={vi.fn()} />);
    // 8 visible chips + 1 overflow control.
    expect(screen.getAllByTestId("quick-board")).toHaveLength(8);
    expect(screen.getByTestId("quick-boards-overflow")).toBeInTheDocument();
  });
});
