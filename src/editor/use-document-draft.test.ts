import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentDraft } from "./use-document-draft";
import { flushAllDrafts } from "./draft-flush-registry";
import { offerDraftHandoff, readDraftHandoff } from "./draft-handoff";
import type { DocumentSaveOptions } from "./corrupt-document";

const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
/** The base the last save carried, read the way the saver reads it when the save runs. */
function baseOf(save: { mock: { calls: unknown[][] } }): unknown {
  const calls = save.mock.calls;
  return (calls[calls.length - 1]?.[2] as DocumentSaveOptions).base?.();
}

const changedDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function setup(persisted = emptyDoc, onUpdate = vi.fn().mockResolvedValue(undefined), onSaved = vi.fn()) {
  return renderHook(
    (props) =>
      useDocumentDraft({
        id: "card-1",
        persistedDocument: props.persisted,
        onUpdate,
        onFinalize: props.onFinalize,
        onSaved,
      }),
    { initialProps: { persisted, onFinalize: vi.fn() } },
  );
}

describe("useDocumentDraft", () => {
  it("flushes a dirty draft on unmount", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const hook = setup(emptyDoc, onUpdate);

    act(() => hook.result.current.handleChange(changedDoc));
    expect(onUpdate).not.toHaveBeenCalled(); // debounced

    hook.unmount();
    // Unmount must flush the pending draft.
    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc, expect.anything());
    expect(baseOf(onUpdate)).toEqual(emptyDoc);
  });

  it("resets dirty after a successful debounced autosave", async () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const hook = setup(emptyDoc, onUpdate);

    act(() => hook.result.current.handleChange(changedDoc));
    act(() => vi.advanceTimersByTime(250));
    // autosave fired once
    expect(onUpdate).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("adopts an incoming document only while clean", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const hook = setup(emptyDoc, onUpdate);

    // Rerender with a new persisted document while clean -> adopted.
    hook.rerender({ persisted: changedDoc, onFinalize: vi.fn() });
    expect(hook.result.current.draft).toEqual(changedDoc);

    // Now make it dirty, then push another incoming value -> must NOT adopt.
    act(() => hook.result.current.handleChange(emptyDoc));
    hook.rerender({ persisted: { type: "doc", content: [] }, onFinalize: vi.fn() });
    expect(hook.result.current.draft).toEqual(emptyDoc); // dirty draft wins
  });

  it("does not finalize during debounced autosave", () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useDocumentDraft({
        id: "card-1",
        persistedDocument: emptyDoc,
        onUpdate,
        onFinalize,
      }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    act(() => vi.advanceTimersByTime(250));

    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc, expect.anything());
    expect(baseOf(onUpdate)).toEqual(emptyDoc);
    expect(onFinalize).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("finalizes the latest dirty draft on demand", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useDocumentDraft({
        id: "card-1",
        persistedDocument: emptyDoc,
        onUpdate,
        onFinalize,
      }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => hook.result.current.handleFinalize());

    expect(onFinalize).toHaveBeenCalledWith("card-1", changedDoc, expect.anything());
  });

  it("registers a draft flusher that persists a dirty draft while still mounted", async () => {
    // Reproduces the navigation data-loss bug at the hook's own boundary: a
    // draft inside its debounce window must be reachable by an external
    // barrier (board navigation's drainPendingWrites) *before* unmount, not
    // only via blur or the too-late unmount flush.
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    expect(onUpdate).not.toHaveBeenCalled(); // still inside the 250ms debounce

    await act(async () => {
      await flushAllDrafts();
    });

    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc, expect.anything());

    // The hook is still mounted and clean: unmounting now must not re-send it.
    onUpdate.mockClear();
    hook.unmount();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("unregisters its flusher on unmount so a stale draft is never re-flushed", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    hook.unmount(); // flushes on unmount and clears dirty

    onUpdate.mockClear();
    await act(async () => {
      await flushAllDrafts();
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not finalize twice when blur follows Enter before persistence completes", async () => {
    let resolveFinalize!: () => void;
    const pendingFinalize = new Promise<void>((resolve) => {
      resolveFinalize = resolve;
    });
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockReturnValue(pendingFinalize);
    const hook = renderHook(() =>
      useDocumentDraft({
        id: "card-1",
        persistedDocument: emptyDoc,
        onUpdate,
        onFinalize,
      }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    let enterFinalize!: Promise<void>;
    act(() => {
      enterFinalize = hook.result.current.handleFinalize();
      hook.result.current.handleBlur();
    });

    expect(onFinalize).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFinalize();
      await enterFinalize;
    });
  });

  it("judges a save by the base confirmed when it runs, not when it was issued", async () => {
    vi.useFakeTimers();
    const laterDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "later" }] }] };
    // A queue of one: the finalize runs only after the autosave's write landed and was confirmed.
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => (finishFirst = resolve));
    const onUpdate = vi.fn(async (_id: string, doc: unknown, options?: DocumentSaveOptions) => {
      await firstDone;
      options?.confirmed?.(doc);
    });
    let baseWhenRun: unknown;
    const onFinalize = vi.fn(async (_id: string, doc: unknown, options?: DocumentSaveOptions) => {
      await firstDone;
      baseWhenRun = options?.base?.();
      options?.confirmed?.(doc);
    });
    const hook = renderHook(() =>
      useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onFinalize }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    act(() => vi.advanceTimersByTime(250));
    // Typed on and left while the autosave was in flight.
    act(() => hook.result.current.handleChange(laterDoc));
    act(() => hook.result.current.handleBlur());
    await act(async () => finishFirst());

    expect(baseWhenRun).toBe(changedDoc);
    vi.useRealTimers();
  });

  it("hands editing to the conflict copy: the closing editor's text goes there, then it shows the stored text", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const moreDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi more" }] }] };
    const onUpdate = vi.fn().mockResolvedValue({ stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" });
    const onSaved = vi.fn();
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onSaved, editing: props.editing }),
      { initialProps: { editing: true } },
    );

    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));
    const lineage = (onUpdate.mock.calls[0][2] as DocumentSaveOptions).draft;

    // A keystroke before the original editor closes, then its blur: both go to the copy.
    act(() => hook.result.current.handleChange(moreDoc));
    onUpdate.mockClear();
    act(() => hook.result.current.handleBlur());
    expect(onSaved).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith("card-1", moreDoc, expect.objectContaining({ draft: lineage }));
    expect(lineage?.latest).toBe(moreDoc);

    // Editing moved on: the original shows the stored text and has nothing left to save.
    hook.rerender({ editing: false });
    expect(hook.result.current.draft).toBe(theirs);
    onUpdate.mockClear();
    hook.unmount();
    expect(onUpdate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("shows the stored text when editing moved to the copy before the conflict came back", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const conflict = { stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" };
    let settleSave!: (conflict: unknown) => void;
    let settleBlur!: (conflict: unknown) => void;
    const onUpdate = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockReturnValueOnce(new Promise((resolve) => (settleSave = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (settleBlur = resolve)));
    const onSaved = vi.fn();
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onSaved, editing: props.editing }),
      { initialProps: { editing: true } },
    );
    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));

    // The copy took editing while the save was still writing into it; the
    // closing editor's blur finalized the same line.
    act(() => hook.result.current.handleBlur());
    hook.rerender({ editing: false });
    await act(async () => settleSave(conflict));
    await act(async () => settleBlur(conflict));
    // Editing goes on in the copy: the original's late answers do not end it.
    expect(onSaved).not.toHaveBeenCalled();

    // Opened again: the editor shows the stored text, not the handed-off draft.
    hook.rerender({ editing: true });
    expect(hook.result.current.draft).toBe(theirs);
    onUpdate.mockClear();
    hook.unmount();
    expect(onUpdate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a blur's late finalize does not end editing that moved to the copy while the editor was open", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const conflict = { stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" };
    let settleSave!: (conflict: unknown) => void;
    let settleBlur!: (conflict: unknown) => void;
    const onUpdate = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockReturnValueOnce(new Promise((resolve) => (settleSave = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (settleBlur = resolve)));
    const onSaved = vi.fn();
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onSaved, editing: props.editing }),
      { initialProps: { editing: true } },
    );
    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));

    // The blur queued a finalize; the conflict came back while the editor was still open.
    act(() => hook.result.current.handleBlur());
    await act(async () => settleSave(conflict));
    hook.rerender({ editing: false });
    await act(async () => settleBlur(undefined));

    expect(onSaved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a late answer of the first hand-off does not end editing after a second one", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const conflict = { stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" };
    const conflict2 = { stored: theirs, copyId: "copy-2", editingMovedTo: "copy-2" };
    let settleSave!: (conflict: unknown) => void;
    let settleBlur!: (conflict: unknown) => void;
    let settleSave2!: (conflict: unknown) => void;
    const onUpdate = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockReturnValueOnce(new Promise((resolve) => (settleSave = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (settleBlur = resolve)))
      // The closing editor's text forwarded to the first copy.
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise((resolve) => (settleSave2 = resolve)));
    const onSaved = vi.fn();
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onSaved, editing: props.editing }),
      { initialProps: { editing: true } },
    );
    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));
    act(() => hook.result.current.handleBlur());
    hook.rerender({ editing: false });
    await act(async () => settleSave(conflict));

    // Opened again, typed, and handed off a second time.
    hook.rerender({ editing: true });
    const typed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "again" }] }] };
    act(() => hook.result.current.handleChange(typed));
    await act(async () => vi.advanceTimersByTime(250));
    hook.rerender({ editing: false });
    await act(async () => settleSave2(conflict2));

    await act(async () => settleBlur(undefined));
    expect(onSaved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("a retired line's finalize in flight does not cost a new session its text", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const conflict = { stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" };
    let settleSave!: (conflict: unknown) => void;
    const onUpdate = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockReturnValueOnce(new Promise((resolve) => (settleSave = resolve)))
      // Finalize of the handed-off line: still writing into the copy.
      .mockReturnValueOnce(new Promise(() => {}));
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, editing: props.editing }),
      { initialProps: { editing: true } },
    );
    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));
    act(() => hook.result.current.handleBlur());
    hook.rerender({ editing: false });
    await act(async () => settleSave(conflict));

    // The original opened again: typed, clicked away, and the card unmounted at once.
    hook.rerender({ editing: true });
    const typed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "again" }] }] };
    act(() => hook.result.current.handleChange(typed));
    act(() => hook.result.current.handleBlur());
    hook.unmount();

    expect(onUpdate).toHaveBeenCalledWith("card-1", typed, expect.anything());
    vi.useRealTimers();
  });

  it("does not swallow the blur of a later editing session after a hand-off", async () => {
    vi.useFakeTimers();
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const onUpdate = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce({ stored: theirs, copyId: "copy-1", editingMovedTo: "copy-1" });
    const onSaved = vi.fn();
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onSaved, editing: props.editing }),
      { initialProps: { editing: true } },
    );
    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => vi.advanceTimersByTime(250));

    // The original editor was replaced by static content and never blurred;
    // later the user opens it again and clicks away without typing.
    hook.rerender({ editing: false });
    hook.rerender({ editing: true });
    act(() => hook.result.current.handleBlur());

    expect(onSaved).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("ends editing after a final save whose text went to a conflict copy", async () => {
    const theirs = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "theirs" }] }] };
    const onSaved = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue({ stored: theirs, copyId: "copy-1", editingMovedTo: null });
    const hook = renderHook(() =>
      useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onFinalize, onSaved }),
    );

    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => hook.result.current.handleFinalize());

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(hook.result.current.draft).toBe(theirs);
  });

  it("a reload's flush saves a dirty draft as an autosave and keeps editing", async () => {
    const onSaved = vi.fn();
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onFinalize = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() =>
      useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, onFinalize, onSaved }),
    );

    // A clean draft: nothing to save, and editing is not ended.
    await act(async () => flushAllDrafts("save"));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    act(() => hook.result.current.handleChange(changedDoc));
    await act(async () => flushAllDrafts("save"));
    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc, expect.anything());
    expect(onFinalize).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    // Leaving the board still finalizes.
    await act(async () => flushAllDrafts("finalize"));
    expect(onSaved).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("a draft that editing is handed to starts from the offered text and saves it", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const lineage = { latest: changedDoc as unknown };
    offerDraftHandoff("card-1", () => lineage.latest);
    const hook = renderHook(
      (props: { editing: boolean }) =>
        useDocumentDraft({ id: "card-1", persistedDocument: emptyDoc, onUpdate, editing: props.editing }),
      { initialProps: { editing: false } },
    );
    // Typed in the original after the offer was made.
    const newer = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi!" }] }] };
    lineage.latest = newer;

    await act(async () => hook.rerender({ editing: true }));

    expect(hook.result.current.draft).toBe(newer);
    expect(onUpdate).toHaveBeenCalledWith("card-1", newer, expect.anything());
    // The offer is used up.
    expect(readDraftHandoff("card-1")).toBeUndefined();
    hook.unmount();
  });
});
