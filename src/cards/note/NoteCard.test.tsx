import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteCard } from "./NoteCard";
import type { NoteCardDto } from "../../services/workspace-gateway";

function makeNote(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision: 1,
    documentJson: { type: "doc" },
    plainText: "hello",
    ...overrides,
  };
}

describe("NoteCard", () => {
  it("renders the note text in display mode", () => {
    render(<NoteCard note={makeNote()} onUpdate={vi.fn()} />);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("enters editing and commits on Enter", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<NoteCard note={makeNote()} onUpdate={onUpdate} />);

    await user.click(screen.getByText("hello"));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "updated{Enter}");

    expect(onUpdate).toHaveBeenCalledWith("note-1", "updated");
  });

  it("commits on blur", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<NoteCard note={makeNote()} onUpdate={onUpdate} />);

    await user.click(screen.getByText("hello"));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "blurred");
    await user.tab();

    expect(onUpdate).toHaveBeenCalledWith("note-1", "blurred");
  });
});
