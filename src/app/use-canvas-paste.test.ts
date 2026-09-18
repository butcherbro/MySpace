import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasPaste } from "./use-canvas-paste";

function dispatchPaste(target: EventTarget, data: Partial<Record<"text/html" | "text/plain", string>>) {
  const clipboardData = {
    getData: (type: string) => data[type as "text/html" | "text/plain"] ?? "",
  } as DataTransfer;
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  Object.defineProperty(event, "target", { value: target });
  window.dispatchEvent(event);
  return event;
}

describe("useCanvasPaste", () => {
  it("calls onPaste with html+text when pasting outside any text-entry control", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: true, onPaste }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, { "text/html": "<p><b>hi</b></p>", "text/plain": "hi" });
    });

    expect(onPaste).toHaveBeenCalledWith({ html: "<p><b>hi</b></p>", text: "hi" });
    canvasDiv.remove();
  });

  it("falls back to plain text when the clipboard has no text/html", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: true, onPaste }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, { "text/plain": "just text" });
    });

    expect(onPaste).toHaveBeenCalledWith({ html: "", text: "just text" });
    canvasDiv.remove();
  });

  it("ignores paste targeting a contentEditable element (the open note editor)", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: true, onPaste }));

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);

    act(() => {
      dispatchPaste(editable, { "text/html": "<p><b>hi</b></p>", "text/plain": "hi" });
    });

    expect(onPaste).not.toHaveBeenCalled();
    editable.remove();
  });

  it("ignores paste targeting an input/textarea", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: true, onPaste }));

    const input = document.createElement("input");
    document.body.appendChild(input);

    act(() => {
      dispatchPaste(input, { "text/plain": "hi" });
    });

    expect(onPaste).not.toHaveBeenCalled();
    input.remove();
  });

  it("does nothing when disabled (no board open)", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: false, onPaste }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, { "text/plain": "hi" });
    });

    expect(onPaste).not.toHaveBeenCalled();
    canvasDiv.remove();
  });

  it("does nothing when the clipboard has neither html nor text", () => {
    const onPaste = vi.fn();
    renderHook(() => useCanvasPaste({ enabled: true, onPaste }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, {});
    });

    expect(onPaste).not.toHaveBeenCalled();
    canvasDiv.remove();
  });

  it("checks onPasteCards first: when it handles the paste, html/text is never read", () => {
    const onPaste = vi.fn();
    const onPasteCards = vi.fn(() => true);
    renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPasteCards }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, { "text/html": "<p>hi</p>", "text/plain": "hi" });
    });

    expect(onPasteCards).toHaveBeenCalledTimes(1);
    expect(onPaste).not.toHaveBeenCalled();
    canvasDiv.remove();
  });

  it("falls back to html/text when onPasteCards declines (empty card clipboard)", () => {
    const onPaste = vi.fn();
    const onPasteCards = vi.fn(() => false);
    renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPasteCards }));

    const canvasDiv = document.createElement("div");
    document.body.appendChild(canvasDiv);

    act(() => {
      dispatchPaste(canvasDiv, { "text/plain": "just text" });
    });

    expect(onPasteCards).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith({ html: "", text: "just text" });
    canvasDiv.remove();
  });
});
