import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardTabs } from "./BoardTabs";
import type { BoardTab } from "./board-tabs";

function tab(boardId: string, title: string): BoardTab {
  return { boardId, title, colorToken: "terracotta", symbol: null, coverAsset: null };
}

describe("BoardTabs", () => {
  it("renders nothing when only Home is open", () => {
    render(
      <BoardTabs
        homeBoardId="home"
        tabs={[tab("home", "Home")]}
        activeBoardId="home"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("board-tabs")).not.toBeInTheDocument();
  });

  it("renders one tab per open board with Home active", () => {
    render(
      <BoardTabs
        homeBoardId="home"
        tabs={[tab("home", "Home"), tab("a", "Books"), tab("b", "Notes")]}
        activeBoardId="home"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const tabs = screen.getAllByTestId("board-tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute("data-active", "true");
    expect(tabs[1]).toHaveAttribute("data-active", "false");
  });

  it("activating a tab calls onActivate with its board id", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <BoardTabs
        homeBoardId="home"
        tabs={[tab("home", "Home"), tab("a", "Books")]}
        activeBoardId="home"
        onActivate={onActivate}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByText("Books"));
    expect(onActivate).toHaveBeenCalledWith("a");
  });

  it("closing a non-home tab calls onClose with its board id", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <BoardTabs
        homeBoardId="home"
        tabs={[tab("home", "Home"), tab("a", "Books")]}
        activeBoardId="a"
        onActivate={vi.fn()}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Close tab Books" }));
    expect(onClose).toHaveBeenCalledWith("a");
  });

  it("does not render a close control for Home", () => {
    const homeId = "0199f4f0-1234-7abc-8def-0123456789ab";
    render(
      <BoardTabs
        homeBoardId={homeId}
        tabs={[tab(homeId, "Home"), tab("a", "Books")]}
        activeBoardId={homeId}
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Close tab Home/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close tab Books" })).toBeInTheDocument();
  });

  it("exposes the tab contract on focusable label buttons", () => {
    render(
      <BoardTabs
        homeBoardId="home"
        tabs={[tab("home", "Home"), tab("a", "Books")]}
        activeBoardId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[0]).toHaveAttribute("tabIndex", "-1");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("tabIndex", "0");
    expect(screen.getByRole("button", { name: "Close tab Books" })).toBeInTheDocument();
  });

  it("renders a decorative identity thumbnail before each tab label", () => {
    const { container } = render(
      <BoardTabs
        homeBoardId="home"
        tabs={[
          tab("home", "Home"),
          {
            boardId: "a",
            title: "Books",
            colorToken: "terracotta",
            symbol: null,
            coverAsset: {
              id: "asset-1",
              fileName: "cover.png",
              mimeType: "image/png",
              width: null,
              height: null,
              sizeBytes: 0,
              filePath: "asset-1.png",
            },
          },
        ]}
        activeBoardId="a"
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const thumbs = container.querySelectorAll(".board-identity-thumbnail");
    expect(thumbs).toHaveLength(2);
    // Decorative: hidden from the accessibility tree, the title names the board.
    expect(thumbs[0]).toHaveAttribute("aria-hidden", "true");
    // The cover tab renders an image inside its thumbnail.
    expect(thumbs[1].querySelector("img")).toHaveAttribute(
      "src",
      "myspace-asset://localhost/asset-1.png",
    );
  });

  describe("drag-to-reorder", () => {
    // Each tab occupies a fixed 100px slot at its array index, left to right,
    // so `indexAtClientX` in the component can be driven by plain clientX math.
    function stubTabLayout() {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const boardId = this.getAttribute("data-board-id");
        const order = ["home", "a", "b", "c"];
        const index = boardId ? order.indexOf(boardId) : -1;
        const left = index >= 0 ? index * 100 : 0;
        return {
          left,
          right: left + 100,
          top: 0,
          bottom: 34,
          width: 100,
          height: 34,
          x: left,
          y: 0,
          toJSON() {},
        } as DOMRect;
      });
    }

    function dispatchPointer(type: "pointermove" | "pointerup", clientX: number) {
      const event = Object.assign(new Event(type, { bubbles: true }), { clientX, clientY: 0 });
      window.dispatchEvent(event);
    }

    it("dragging a tab past a threshold and releasing reorders the tabs", () => {
      stubTabLayout();
      const onReorder = vi.fn();
      render(
        <BoardTabs
          homeBoardId="home"
          tabs={[tab("home", "Home"), tab("a", "A"), tab("b", "B"), tab("c", "C")]}
          activeBoardId="home"
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onReorder={onReorder}
        />,
      );

      const tabEls = screen.getAllByTestId("board-tab");
      const tabA = tabEls[1]; // slot index 1, x in [100,200)

      fireEvent.pointerDown(tabA, { clientX: 150, clientY: 0, button: 0 });
      // Drag right past tab "c" (slot index 3, x in [300,400)).
      dispatchPointer("pointermove", 350);
      dispatchPointer("pointerup", 350);

      expect(onReorder).toHaveBeenCalledWith("a", 4);
    });

    it("a small movement under the threshold does not trigger a reorder (stays a click)", () => {
      stubTabLayout();
      const onReorder = vi.fn();
      const onActivate = vi.fn();
      render(
        <BoardTabs
          homeBoardId="home"
          tabs={[tab("home", "Home"), tab("a", "A"), tab("b", "B")]}
          activeBoardId="home"
          onActivate={onActivate}
          onClose={vi.fn()}
          onReorder={onReorder}
        />,
      );

      const tabA = screen.getAllByTestId("board-tab")[1];
      fireEvent.pointerDown(tabA, { clientX: 150, clientY: 0, button: 0 });
      dispatchPointer("pointermove", 151);
      dispatchPointer("pointerup", 151);

      expect(onReorder).not.toHaveBeenCalled();
    });

    it("Home is not draggable", () => {
      stubTabLayout();
      const onReorder = vi.fn();
      render(
        <BoardTabs
          homeBoardId="home"
          tabs={[tab("home", "Home"), tab("a", "A")]}
          activeBoardId="home"
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onReorder={onReorder}
        />,
      );

      const homeTab = screen.getAllByTestId("board-tab")[0];
      fireEvent.pointerDown(homeTab, { clientX: 50, clientY: 0, button: 0 });
      dispatchPointer("pointermove", 250);
      dispatchPointer("pointerup", 250);

      expect(onReorder).not.toHaveBeenCalled();
    });
  });
});
