import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDocumentDraft } from "./use-document-draft";

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
