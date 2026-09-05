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
        currentBoardId="a"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Books")).toBeInTheDocument();
  });

  it("collapses middle ancestors for deep trails", () => {
    const trail = [b("home", "Home"), b("a", "A"), b("b", "B"), b("c", "C"), b("d", "Deep")];
    render(
      <BoardBreadcrumbs breadcrumbs={trail} currentBoardId="d" onNavigate={vi.fn()} />,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Deep")).toBeInTheDocument();
    expect(screen.queryByText("B")).not.toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("marks the current board with aria-current and does not disable it", () => {
    render(
      <BoardBreadcrumbs
        breadcrumbs={[b("home", "Home"), b("a", "Books")]}
        currentBoardId="a"
        onNavigate={vi.fn()}
      />,
    );
    const books = screen.getByText("Books");
    expect(books.closest("button")).toHaveAttribute("aria-current", "page");
    expect(books.closest("button")).not.toBeDisabled();
  });

  it("navigates when any crumb (including current) is clicked", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <BoardBreadcrumbs
        breadcrumbs={[b("home", "Home"), b("a", "Books")]}
        currentBoardId="a"
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByText("Home"));
    expect(onNavigate).toHaveBeenCalledWith("home");

    await user.click(screen.getByText("Books"));
    expect(onNavigate).toHaveBeenCalledWith("a");
  });

  it("does not apply aria-current when the id does not match", () => {
    render(
      <BoardBreadcrumbs
        breadcrumbs={[b("home", "Home"), b("a", "Books")]}
        currentBoardId="missing"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByText("Books").closest("button")).not.toHaveAttribute("aria-current");
  });
});
