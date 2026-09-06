import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QuickBoardDto } from "../services/workspace-gateway";
import { QuickBoardsRail } from "./QuickBoardsRail";

function qb(
  boardId: string,
  title: string,
  sortOrder: number,
  overrides: Partial<QuickBoardDto> = {},
): QuickBoardDto {
  return {
    boardId,
    title,
    colorToken: "terracotta",
    symbol: null,
    sortOrder,
    coverAsset: null,
    ...overrides,
  };
}

const noop = {
  onOpen: vi.fn(),
  onRemove: vi.fn(),
  onReorder: vi.fn(),
};

describe("QuickBoardsRail", () => {
  it("stays visible and accepts the first pinned board when empty", () => {
    render(<QuickBoardsRail quickBoards={[]} {...noop} />);

    expect(screen.getByTestId("quick-boards")).toHaveAttribute("data-quick-boards-drop", "true");
    expect(screen.getByRole("navigation", { name: "Quick boards" })).toBeInTheDocument();
  });

  it("uses the board cover before symbol or acronym", () => {
    render(
      <QuickBoardsRail
        quickBoards={[
          qb("a", "Research Notes", 0, {
            symbol: "RN",
            coverAsset: {
              id: "asset-1",
              fileName: "cover.png",
              mimeType: "image/png",
              width: null,
              height: null,
              sizeBytes: 0,
              filePath: "asset-1.png",
            },
          }),
        ]}
        {...noop}
      />,
    );

    expect(document.querySelector(".quick-boards-rail__cover")).toHaveAttribute(
      "src",
      "myspace-asset://localhost/asset-1.png",
    );
    expect(screen.queryByText("RN")).not.toBeInTheDocument();
  });

  it("uses the board symbol, then a three-word acronym as visual fallback", () => {
    render(
      <QuickBoardsRail
        quickBoards={[
          qb("a", "Books", 0, { symbol: "BK" }),
          qb("b", "YouTube Content Research Library", 1),
        ]}
        {...noop}
      />,
    );

    expect(screen.getByTestId("quick-board-identity-a")).toHaveTextContent("BK");
    expect(screen.getByTestId("quick-board-identity-b")).toHaveTextContent("YCR");
  });

  it("opens and removes only the quick-board reference", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <QuickBoardsRail
        quickBoards={[qb("a", "Books", 0)]}
        {...noop}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open quick board Books" }));
    await user.click(screen.getByRole("button", { name: "Remove quick board Books" }));
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("reports the complete order after vertical drag reordering", () => {
    const onReorder = vi.fn();
    render(
      <QuickBoardsRail
        quickBoards={[qb("a", "Books", 0), qb("b", "Notes", 1), qb("c", "Slides", 2)]}
        {...noop}
        onReorder={onReorder}
      />,
    );

    const rows = screen.getAllByTestId("quick-board");
    fireEvent.dragStart(rows[2]);
    fireEvent.dragOver(rows[0], { dataTransfer: { dropEffect: "move" } });
    fireEvent.drop(rows[0]);

    expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("inserts before the hovered row when reordering downward", () => {
    const onReorder = vi.fn();
    render(
      <QuickBoardsRail
        quickBoards={[qb("a", "Books", 0), qb("b", "Notes", 1), qb("c", "Slides", 2)]}
        {...noop}
        onReorder={onReorder}
      />,
    );

    const rows = screen.getAllByTestId("quick-board");
    fireEvent.dragStart(rows[0]);
    fireEvent.dragOver(rows[2], { dataTransfer: { dropEffect: "move" } });
    fireEvent.drop(rows[2]);

    expect(onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
  });
});
