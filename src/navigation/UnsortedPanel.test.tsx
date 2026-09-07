import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnsortedPanel } from "./UnsortedPanel";
import type { CardDto } from "../services/workspace-gateway";

function note(id: string, text = "hello"): CardDto {
  return {
    kind: "note",
    id,
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc" },
    plainText: text,
  };
}

describe("UnsortedPanel", () => {
  it("renders nothing when there are no unsorted cards", () => {
    render(<UnsortedPanel cards={[]} onPlace={vi.fn()} />);
    expect(screen.queryByTestId("unsorted-panel")).not.toBeInTheDocument();
  });

  it("renders a row per unsorted card with a Place action", async () => {
    const user = userEvent.setup();
    const onPlace = vi.fn();
    render(<UnsortedPanel cards={[note("a"), note("b", "second")]} onPlace={onPlace} />);

    expect(screen.getAllByTestId("unsorted-card")).toHaveLength(2);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Place" })[0]);
    expect(onPlace).toHaveBeenCalledWith("a");
  });
});