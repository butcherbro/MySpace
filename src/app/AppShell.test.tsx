import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it('marks the shell with the quiet-desk theme contract', () => {
    render(<AppShell>content</AppShell>);

    expect(screen.getByTestId("app-shell")).toHaveAttribute("data-theme", "system");
  });

  it("renders the shell with the product title", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByText("MySpace")).toBeInTheDocument();
  });

  it("renders children in the body region", () => {
    render(<AppShell><span data-testid="child" /></AppShell>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
