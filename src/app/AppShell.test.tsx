import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

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
    expect(screen.getByTestId("right-rail-region")).toHaveClass("app-shell__right-rail--adjacent");
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

  it("renders a title-bar drag spacer before the top bar content", () => {
    render(
      <AppShell topBar={<span>Trail</span>} toolRail={null}>
        <span>Desk</span>
      </AppShell>,
    );

    const spacer = screen.getByTestId("titlebar-drag-region");
    expect(spacer).toHaveAttribute("data-tauri-drag-region");
    // The spacer is a sibling before the interactive breadcrumb content.
    expect(spacer.compareDocumentPosition(screen.getByTestId("top-bar-region"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("renders a separate Unsorted rail when provided", () => {
    render(
      <AppShell
        topBar={null}
        toolRail={null}
        rightRail={<span>Quick boards</span>}
        unsortedRail={<span>Unsorted</span>}
      >
        <span>Desk</span>
      </AppShell>,
    );

    expect(screen.getByTestId("right-rail-region")).toHaveTextContent("Quick boards");
    expect(screen.getByTestId("right-rail-region")).not.toHaveClass("app-shell__right-rail--adjacent");
    expect(screen.getByTestId("unsorted-rail-region")).toHaveTextContent("Unsorted");
  });
});
