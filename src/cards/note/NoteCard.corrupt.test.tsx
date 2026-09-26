import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteCard } from "./NoteCard";
import type { NoteCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";
import { flushAllDrafts } from "../../editor/draft-flush-registry";
import { reducer, initialState } from "../../state/current-board-store";

// P1.7: a note whose stored document could not be parsed.

vi.mock("../../editor/NoteEditor", () => ({
  NoteEditor: vi.fn((props: { onBlur?: () => void }) => (
    <textarea data-testid="mock-editor" onBlur={() => props.onBlur?.()} />
  )),
}));

type MockProps = { document: unknown; onChange: (d: unknown) => void; onBlur?: () => void };

const editorMock = NoteEditor as unknown as ReturnType<typeof vi.fn>;
function lastEditorProps(): MockProps {
  const calls = editorMock.mock.calls;
  return calls[calls.length - 1][0] as MockProps;
}

function corruptNote(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision: 3,
    documentJson: { type: "doc", content: [] },
    plainText: "first line\nsecond line",
    colorToken: "default",
    corrupt: true,
    ...overrides,
  };
}

const typedDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "fixed" }] }] };

function renderCard(note: NoteCardDto, editing: boolean, onUpdate = vi.fn().mockResolvedValue(undefined)) {
  const props = { onDeactivate: vi.fn(), onUpdate, onContextMenu: vi.fn(), onResize: vi.fn() };
  const view = render(<NoteCard note={note} editing={editing} {...props} />);
  return {
    ...view,
    onUpdate,
    rerenderWith: (next: NoteCardDto, nextEditing: boolean) =>
      view.rerender(<NoteCard note={next} editing={nextEditing} {...props} />),
  };
}

describe("NoteCard corrupt state (P1.7)", () => {
  it("shows the recovered plain text statically with a damaged banner and no editor", () => {
    editorMock.mockClear();
    renderCard(corruptNote(), false);
    const card = screen.getByTestId("note-card");
    expect(card).toHaveAttribute("data-corrupt", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Damaged note — showing recovered text");
    const paragraphs = [...card.querySelectorAll("[data-static-document] p")].map((p) => p.textContent);
    expect(paragraphs).toEqual(["first line", "second line"]);
    expect(screen.getByRole("button", { name: "Repair" })).toBeInTheDocument();
    expect(editorMock).not.toHaveBeenCalled();
  });

  it("does not mount the editor or save when a damaged note is activated", async () => {
    editorMock.mockClear();
    const { onUpdate } = renderCard(corruptNote(), true);
    expect(editorMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    // The navigation barrier finds nothing to write either.
    await act(async () => {
      await flushAllDrafts();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("Repair opens the editor on the recovered text and the first save acknowledges the corruption", async () => {
    vi.useFakeTimers();
    editorMock.mockClear();
    const { onUpdate, rerenderWith } = renderCard(corruptNote(), true);

    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(screen.getByTestId("mock-editor")).toBeInTheDocument();
    expect(lastEditorProps().document).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    });

    act(() => lastEditorProps().onChange(typedDoc));
    act(() => vi.advanceTimersByTime(250));
    expect(onUpdate).toHaveBeenCalledWith("note-1", typedDoc, { acknowledgeCorrupt: true });
    await act(async () => {});

    // The receipt-driven store update clears `corrupt`; the card is normal and
    // later saves carry no acknowledgement.
    rerenderWith(corruptNote({ corrupt: false, documentJson: typedDoc, revision: 4 }), true);
    expect(screen.getByTestId("note-card")).toHaveAttribute("data-corrupt", "false");
    onUpdate.mockClear();
    act(() => lastEditorProps().onChange(typedDoc));
    act(() => vi.advanceTimersByTime(250));
    expect(onUpdate).toHaveBeenCalledWith("note-1", typedDoc);
    vi.useRealTimers();
  });

  it("the content-updated reducer clears the corrupt flag", () => {
    const state = { ...initialState, cards: [corruptNote()] };
    const next = reducer(state, {
      type: "cardContentUpdated",
      id: "note-1",
      revision: 4,
      documentJson: typedDoc,
      plainText: "fixed",
    });
    expect((next.cards[0] as NoteCardDto).corrupt).toBe(false);
  });
});
