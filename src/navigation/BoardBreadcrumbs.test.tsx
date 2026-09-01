import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BoardBreadcrumbs } from "./BoardBreadcrumbs";
import type { Breadcrumb } from "../services/workspace-gateway";

function b(id: string, title: string): Breadcrumb {
  return { id, title };
}

describe("BoardBreadcrumbs", () => {
  it("renders a shallow trail without collapsing", () => {
    render(
      <BoardBreadcrumbs
        breadcrumbs={[b("home", "Home"), b("a", "Books")]}
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Books")).toBeInTheDocument();
  });

  it("collapses middle ancestors for deep trails", () => {
    const trail = [b("home", "Home"), b("a", "A"), b("b", "B"), b("c", "C"), b("d", "Deep")];
    render(<BoardBreadcrumbs breadcrumbs={trail} onNavigate={vi.fn()} />);
    // Home and the last two are shown; middle "B" is collapsed.
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Deep")).toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("navigates when a non-current crumb is clicked", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <BoardBreadcrumbs
        breadcrumbs={[b("home", "Home"), b("a", "Books")]}
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByText("Home"));
    expect(onNavigate).toHaveBeenCalledWith("home");
  });
});
