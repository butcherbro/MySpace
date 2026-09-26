import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteCard } from "./NoteCard";
import type { NoteCardDto } from "../../services/workspace-gateway";
import { NoteEditor } from "../../editor/NoteEditor";

// NoteCard talks to Tiptap exclusively through the `NoteEditor` contract
// (document/editable/onChange/onBlur). Mock it here so we test NoteCard's own
// buffering, debounce, and flush logic rather than Tiptap's jsdom quirks.
vi.mock("../../editor/NoteEditor", () => ({
  NoteEditor: vi.fn(
    (props: { document: unknown; editable: boolean; onChange: (d: unknown) => void; onBlur?: () => void }) => (
      <textarea
        data-testid="mock-editor"
        contentEditable={props.editable}
        onBlur={() => props.onBlur?.()}
      />
    ),
  ),
}));

type MockProps = {
  document: unknown;
  editable: boolean;
  onChange: (d: unknown) => void;
  onBlur?: () => void;
};

function lastEditorProps(): MockProps | undefined {
  const m = NoteEditor as unknown as ReturnType<typeof vi.fn>;
  const calls = m.mock.calls;
  return calls[calls.length - 1]?.[0] as MockProps | undefined;
}

function makeNote(overrides: Partial<NoteCardDto> = {}): NoteCardDto {
  return {
    kind: "note",
    id: "note-1",
    boardId: "home",
    frame: { x: 0, y: 0, width: 200, height: 80 },
    zIndex: 0,
    revision: 1,
    documentJson: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    },
    plainText: "hello",
    colorToken: "default",
    ...overrides,
  };
}

const changedDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }],
};

describe("NoteCard", () => {
  it("exposes the note semantic kind and lifecycle hooks on the root", () => {
    render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    const card = screen.getByTestId("note-card");
    expect(card).toHaveAttribute("data-kind", "note");
    expect(card).toHaveAttribute("data-editing", "false");
    expect(card).toHaveAttribute("data-saving", "false");
    expect(card).toHaveAttribute("data-error", "false");
  });

  it("renders an idle note as static HTML without mounting an editor (P1.8)", () => {
    (NoteEditor as unknown as ReturnType<typeof vi.fn>).mockClear();
    render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    expect(NoteEditor).not.toHaveBeenCalled();
    const card = screen.getByTestId("note-card");
    expect(card.querySelector("[data-static-document] p")?.textContent).toBe("hello");
  });

  it("mounts the editor on the persisted document when editing starts, and unmounts it after", () => {
    const m = NoteEditor as unknown as ReturnType<typeof vi.fn>;
    m.mockClear();
    const { rerender } = render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    const card = screen.getByTestId("note-card");
    fireEvent.pointerDown(card, { clientX: 12, clientY: 34 });
    rerender(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    expect(lastEditorProps()?.editable).toBe(true);
    expect(lastEditorProps()?.document).toEqual(makeNote().documentJson);
    // The click that started editing is forwarded so the caret lands there.
    expect((lastEditorProps() as { initialCaretPoint?: unknown }).initialCaretPoint).toEqual({ x: 12, y: 34 });
    expect(screen.getByTestId("mock-editor")).toBeInTheDocument();

    rerender(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    expect(screen.queryByTestId("mock-editor")).toBeNull();
    expect(card.querySelector("[data-static-document]")).not.toBeNull();
  });

  it("passes editable=true when the note is being edited", () => {
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    expect(lastEditorProps()?.editable).toBe(true);
  });

  it("flushes on blur and deactivates", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDeactivate = vi.fn();
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={onDeactivate} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    act(() => lastEditorProps()?.onChange(changedDoc));
    await act(async () => lastEditorProps()?.onBlur?.());

    expect(onUpdate).toHaveBeenCalledWith("note-1", changedDoc);
    expect(onDeactivate).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("debounces autosave while editing", () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    act(() => lastEditorProps()?.onChange(changedDoc));

    expect(onUpdate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(onUpdate).toHaveBeenCalledWith("note-1", changedDoc);
    vi.useRealTimers();
  });

  it("keeps the editor open and the draft visible when save fails", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    const onDeactivate = vi.fn();
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={onDeactivate} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    act(() => lastEditorProps()?.onChange(changedDoc));
    await act(async () => lastEditorProps()?.onBlur?.());

    // Save failed: the editor must NOT close, and the draft must be retried later.
    expect(onDeactivate).not.toHaveBeenCalled();
    expect(screen.getByTestId("note-card")).toHaveAttribute("data-error", "true");

    // A subsequent blur (still editing) retries the same save.
    await act(async () => lastEditorProps()?.onBlur?.());
    expect(onUpdate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("grows the card height to fit overflowing content while editing, debounced like autosave", () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn().mockResolvedValue(undefined)} onContextMenu={vi.fn()} onResize={onResize} />,
    );

    // jsdom has no real layout engine: fake the measurement the component reads
    // (scrollHeight = full content height, clientHeight = the currently applied
    // frame height) to simulate a paste that overflows the 80px starting frame.
    const card = screen.getByTestId("note-card");
    Object.defineProperty(card, "clientHeight", { configurable: true, value: 80 });
    Object.defineProperty(card, "scrollHeight", { configurable: true, value: 220 });

    act(() => lastEditorProps()?.onChange(changedDoc));

    // No avalanche of writes: the grow, like content autosave, is debounced.
    expect(onResize).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(onResize).toHaveBeenCalledWith("note-1", 200, 220);
    vi.useRealTimers();
  });

  it("does not fight a manual shrink below content height after growing", () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const { rerender } = render(
      <NoteCard note={makeNote()} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn().mockResolvedValue(undefined)} onContextMenu={vi.fn()} onResize={onResize} />,
    );

    const card = screen.getByTestId("note-card");
    Object.defineProperty(card, "clientHeight", { configurable: true, value: 80 });
    Object.defineProperty(card, "scrollHeight", { configurable: true, value: 220 });
    act(() => lastEditorProps()?.onChange(changedDoc));
    act(() => vi.advanceTimersByTime(250));
    expect(onResize).toHaveBeenCalledWith("note-1", 200, 220);

    // The note re-renders with the grown, persisted frame (as the parent would
    // after the resize command lands), then the user manually drags the handle
    // down to something smaller than the content needs.
    onResize.mockClear();
    // Real layout would now report clientHeight === scrollHeight (the frame
    // grew to fit); jsdom doesn't lay anything out, so the fake measurement is
    // updated by hand to keep matching what the applied height would produce.
    Object.defineProperty(card, "clientHeight", { configurable: true, value: 220 });
    Object.defineProperty(card, "scrollHeight", { configurable: true, value: 220 });
    rerender(
      <NoteCard note={makeNote({ frame: { x: 0, y: 0, width: 200, height: 220 } })} editing={true} onDeactivate={vi.fn()} onUpdate={vi.fn().mockResolvedValue(undefined)} onContextMenu={vi.fn()} onResize={onResize} />,
    );
    const handle = screen.getByTestId("note-resize");
    // jsdom doesn't implement the Pointer Events capture API used by the drag handler.
    (handle as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 }); // drag up by 120 -> height 100
    fireEvent.pointerUp(window);
    expect(onResize).toHaveBeenLastCalledWith("note-1", 200, 100);

    // No further grow write should fire just from the shrink settling.
    onResize.mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(onResize).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("adopts an external document change only while clean", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    // Snapshot reload delivers a new persisted document while the note is clean.
    const restored = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "restored" }] }],
    };
    rerender(
      <NoteCard note={makeNote({ documentJson: restored, plainText: "restored" })} editing={false} onDeactivate={vi.fn()} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    // Enter editing: the draft must reflect the restored document, not "hello".
    rerender(
      <NoteCard note={makeNote({ documentJson: restored, plainText: "restored" })} editing={true} onDeactivate={vi.fn()} onUpdate={onUpdate} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );

    // The editor is passed the restored document as the base (not the stale mount-time doc).
    expect(lastEditorProps()?.document).toEqual(restored);
    vi.useRealTimers();
  });
});
