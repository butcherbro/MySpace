import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { extractPathCandidate, useCanvasPaste } from "./use-canvas-paste";

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

  it("ignores paste when document.activeElement is the editor, even if e.target is document (todo.md №25: WKWebView paste can target document while something is focused)", () => {
    const onPaste = vi.fn();
    const onPasteCards = vi.fn(() => false);
    renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPasteCards }));

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();
    expect(document.activeElement).toBe(editable);

    act(() => {
      // Simulate the real WKWebView paste: the DOM event's `target` is the
      // document, not the focused contenteditable — only `document.activeElement`
      // still points at the editor.
      dispatchPaste(document, { "text/html": "<p>hi</p>", "text/plain": "hi" });
    });

    expect(onPaste).not.toHaveBeenCalled();
    expect(onPasteCards).not.toHaveBeenCalled();
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

  describe("path paste (todo.md №23)", () => {
    it("hands an existing path to onPastePath and never falls back to onPaste", async () => {
      const onPaste = vi.fn();
      const onPastePath = vi.fn().mockResolvedValue(true);
      renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPastePath }));

      const canvasDiv = document.createElement("div");
      document.body.appendChild(canvasDiv);

      await act(async () => {
        dispatchPaste(canvasDiv, { "text/plain": "/Users/bro/Projects/MySpace" });
        await Promise.resolve();
      });

      expect(onPastePath).toHaveBeenCalledWith("/Users/bro/Projects/MySpace");
      expect(onPaste).not.toHaveBeenCalled();
      canvasDiv.remove();
    });

    it("falls back to a normal note paste when onPastePath reports a missing path", async () => {
      const onPaste = vi.fn();
      const onPastePath = vi.fn().mockResolvedValue(false);
      renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPastePath }));

      const canvasDiv = document.createElement("div");
      document.body.appendChild(canvasDiv);

      await act(async () => {
        dispatchPaste(canvasDiv, { "text/plain": "/Users/bro/does-not-exist" });
        await Promise.resolve();
      });

      expect(onPastePath).toHaveBeenCalledWith("/Users/bro/does-not-exist");
      expect(onPaste).toHaveBeenCalledWith({ html: "", text: "/Users/bro/does-not-exist" });
      canvasDiv.remove();
    });

    it("treats a home-relative ~/ path as a path candidate too", async () => {
      const onPaste = vi.fn();
      const onPastePath = vi.fn().mockResolvedValue(true);
      renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPastePath }));

      const canvasDiv = document.createElement("div");
      document.body.appendChild(canvasDiv);

      await act(async () => {
        dispatchPaste(canvasDiv, { "text/plain": "~/Projects/MySpace" });
        await Promise.resolve();
      });

      expect(onPastePath).toHaveBeenCalledWith("~/Projects/MySpace");
      canvasDiv.remove();
    });

    it("never calls onPastePath for multi-line text, even if it starts with /", async () => {
      const onPaste = vi.fn();
      const onPastePath = vi.fn().mockResolvedValue(true);
      renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPastePath }));

      const canvasDiv = document.createElement("div");
      document.body.appendChild(canvasDiv);

      const multiline = "/not/a/path\nsecond line";
      await act(async () => {
        dispatchPaste(canvasDiv, { "text/plain": multiline });
        await Promise.resolve();
      });

      expect(onPastePath).not.toHaveBeenCalled();
      expect(onPaste).toHaveBeenCalledWith({ html: "", text: multiline });
      canvasDiv.remove();
    });

    it("never calls onPastePath for plain text that isn't path-shaped", () => {
      const onPaste = vi.fn();
      const onPastePath = vi.fn().mockResolvedValue(true);
      renderHook(() => useCanvasPaste({ enabled: true, onPaste, onPastePath }));

      const canvasDiv = document.createElement("div");
      document.body.appendChild(canvasDiv);

      act(() => {
        dispatchPaste(canvasDiv, { "text/plain": "just some text" });
      });

      expect(onPastePath).not.toHaveBeenCalled();
      expect(onPaste).toHaveBeenCalledWith({ html: "", text: "just some text" });
      canvasDiv.remove();
    });
  });
});

describe("extractPathCandidate", () => {
  it("accepts a single-line absolute path", () => {
    expect(extractPathCandidate("/Users/bro/Projects/MySpace")).toBe("/Users/bro/Projects/MySpace");
  });

  it("accepts a single-line home-relative path", () => {
    expect(extractPathCandidate("~/Projects/MySpace")).toBe("~/Projects/MySpace");
  });

  it("accepts a bare ~", () => {
    expect(extractPathCandidate("~")).toBe("~");
  });

  it("trims a trailing newline the clipboard commonly adds", () => {
    expect(extractPathCandidate("/Users/bro/Projects/MySpace\n")).toBe("/Users/bro/Projects/MySpace");
  });

  it("rejects genuinely multi-line text even when it starts with /", () => {
    expect(extractPathCandidate("/not/a/path\nsecond line")).toBeNull();
  });

  it("rejects text that doesn't start with / or ~/", () => {
    expect(extractPathCandidate("just some text")).toBeNull();
    expect(extractPathCandidate("relative/path")).toBeNull();
  });

  it("accepts Windows drive, UNC and ~\\ paths", () => {
    expect(extractPathCandidate("C:\\Users\\bro\\Docs")).toBe("C:\\Users\\bro\\Docs");
    expect(extractPathCandidate("D:/data")).toBe("D:/data");
    expect(extractPathCandidate("\\\\server\\share\\dir")).toBe("\\\\server\\share\\dir");
    expect(extractPathCandidate("~\\Docs")).toBe("~\\Docs");
  });

  it("unwraps Explorer's quoted 'Copy as path' output", () => {
    expect(extractPathCandidate('"C:\\Users\\bro\\a.txt"\r\n')).toBe("C:\\Users\\bro\\a.txt");
    expect(extractPathCandidate('"/Users/bro/a.txt"')).toBe("/Users/bro/a.txt");
  });

  it("rejects drive-relative and URL-like text", () => {
    expect(extractPathCandidate("C:relative")).toBeNull();
    expect(extractPathCandidate("https://example.com/a")).toBeNull();
  });

  it("rejects empty/whitespace-only text", () => {
    expect(extractPathCandidate("")).toBeNull();
    expect(extractPathCandidate("   ")).toBeNull();
  });
});
