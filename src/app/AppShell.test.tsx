import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn() }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

describe("AppShell", () => {
  it('marks the shell with the quiet-desk theme contract', () => {
    render(<AppShell topBar={null} toolRail={null}>content</AppShell>);

    expect(screen.getByTestId("app-shell")).toHaveAttribute("data-theme", "system");
  });

  it("renders explicit top bar, tool rail, and canvas regions", () => {
    render(
      <AppShell topBar={<span>Trail</span>} toolRail={<span>Tools</span>}>
        <span>Desk</span>
      </AppShell>,
    );

    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("top-bar-region")).toHaveTextContent("Trail");
    expect(screen.getByTestId("tool-rail-region")).toHaveTextContent("Tools");
    expect(screen.getByTestId("canvas-region")).toHaveTextContent("Desk");
    expect(screen.queryByText("MySpace")).not.toBeInTheDocument();
  });

  it("renders an optional right rail beside the canvas", () => {
    render(
      <AppShell topBar={null} toolRail={null} rightRail={<span>Quick boards</span>}>
        <span>Desk</span>
      </AppShell>,
    );

    expect(screen.getByTestId("right-rail-region")).toHaveTextContent("Quick boards");
    expect(screen.getByTestId("canvas-region")).toHaveTextContent("Desk");
  });

  it("exposes the collapsed right-rail state to the layout", () => {
    render(
      <AppShell topBar={null} toolRail={null} rightRail={<span>Quick boards</span>} rightRailCollapsed>
        <span>Desk</span>
      </AppShell>,
    );

    expect(screen.getByTestId("app-shell")).toHaveClass("app-shell--right-rail-collapsed");
    expect(screen.getByTestId("right-rail-region")).toHaveAttribute("data-collapsed", "true");
  });

  it("starts a window drag from the title bar and skips interactive chrome", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    startDragging.mockClear();

    render(
      <AppShell topBar={<button type="button">Trail</button>} toolRail={null}>
        <span>Desk</span>
      </AppShell>,
    );

    // The empty spacer still sits before the interactive top-bar content.
    const spacer = screen.getByTestId("titlebar-drag-region");
    expect(spacer.compareDocumentPosition(screen.getByTestId("top-bar-region"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // WKWebView ignores CSS app-region, so the shell starts the drag imperatively.
    fireEvent.mouseDown(screen.getByTestId("title-bar-region"), { button: 0 });
    await vi.waitFor(() => expect(startDragging).toHaveBeenCalledTimes(1));

    // Interactive chrome keeps its own behaviour instead of moving the window.
    fireEvent.mouseDown(screen.getByRole("button", { name: "Trail" }), { button: 0 });
    await Promise.resolve();
    expect(startDragging).toHaveBeenCalledTimes(1);
  });
});
