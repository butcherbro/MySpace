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
    render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} />,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows an editor when editing is true", () => {
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} />,
    );
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("commits on Enter and calls onDeactivate", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDeactivate = vi.fn();
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={onDeactivate} onUpdate={onUpdate} onContextMenu={vi.fn()} />,
    );

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "updated{Enter}");

    expect(onUpdate).toHaveBeenCalledWith("note-1", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "updated" }] }],
    });
    expect(onDeactivate).toHaveBeenCalled();
  });

  it("commits on blur", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDeactivate = vi.fn();
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={onDeactivate} onUpdate={onUpdate} onContextMenu={vi.fn()} />,
    );

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "blurred");
    await user.tab();

    expect(onUpdate).toHaveBeenCalledWith("note-1", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "blurred" }] }],
    });
  });
});
