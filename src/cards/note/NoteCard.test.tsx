import { act, render } from "@testing-library/react";
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
    ...overrides,
  };
}

const changedDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "changed" }] }],
};

describe("NoteCard", () => {
  it("passes the authoritative document and editable flag to the editor", () => {
    render(
      <NoteCard note={makeNote()} editing={false} onDeactivate={vi.fn()} onUpdate={vi.fn()} onContextMenu={vi.fn()} onResize={vi.fn()} />,
    );
    expect(lastEditorProps()?.editable).toBe(false);
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

    // A subsequent blur (still editing) retries the same save.
    await act(async () => lastEditorProps()?.onBlur?.());
    expect(onUpdate).toHaveBeenCalledTimes(2);
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
