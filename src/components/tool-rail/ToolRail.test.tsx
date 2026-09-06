import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

describe("ToolRail", () => {
  it("renders the creation tools in order with accessible labels", () => {
    render(
      <ToolRail
        onNewNote={vi.fn()}
        onNewLink={vi.fn()}
        onNewBoard={vi.fn()}
        onAddImage={vi.fn()}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Creation tools" });
    const buttons = within(toolbar).getAllByRole("button");

    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.textContent)).toEqual(["Note", "Link", "Board", "Image"]);
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add image" })).toBeInTheDocument();
    expect(toolbar.querySelectorAll("svg")).toHaveLength(4);
  });

  it("calls the matching callback when each button is activated", async () => {
    const user = userEvent.setup();
    const onNewNote = vi.fn();
    const onNewLink = vi.fn();
    const onNewBoard = vi.fn();
    const onAddImage = vi.fn();

    render(
      <ToolRail
        onNewNote={onNewNote}
        onNewLink={onNewLink}
        onNewBoard={onNewBoard}
        onAddImage={onAddImage}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.click(screen.getByRole("button", { name: "New link" }));
    await user.click(screen.getByRole("button", { name: "New board" }));
    await user.click(screen.getByRole("button", { name: "Add image" }));

    expect(onNewNote).toHaveBeenCalledTimes(1);
    expect(onNewLink).toHaveBeenCalledTimes(1);
    expect(onNewBoard).toHaveBeenCalledTimes(1);
    expect(onAddImage).toHaveBeenCalledTimes(1);
  });
});
