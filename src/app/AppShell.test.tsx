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
});
