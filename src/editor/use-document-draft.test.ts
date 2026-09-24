import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentDraft } from "./use-document-draft";
import { flushAllDrafts } from "./draft-flush-registry";

const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
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
    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc);
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

    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc);
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

    expect(onFinalize).toHaveBeenCalledWith("card-1", changedDoc);
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

    expect(onUpdate).toHaveBeenCalledWith("card-1", changedDoc);

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
});
