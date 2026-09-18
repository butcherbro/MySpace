import { useEffect } from "react";

export interface CanvasPasteData {
  html: string;
  text: string;
}

export interface CanvasPasteOptions {
  /** Paste is a no-op when no board is open. */
  enabled: boolean;
  onPaste: (data: CanvasPasteData) => void;
}

/**
 * Global "paste creates a note" handling for the empty canvas (no editor open).
 *
 * An open note editor already gets `text/html` paste for free — ProseMirror's
 * own paste handler runs on its contenteditable before this ever sees the
 * event — so this hook must stay out of its way entirely. It only acts when the
 * paste target is NOT a text-entry control (the editor's contenteditable, or any
 * input/textarea), which is also how the canvas's existing Escape/Backspace
 * keydown handling (`App.tsx`) tells "editing" from "canvas-level" apart.
 *
 * Image/file clipboard content is intentionally left alone here — no such
 * canvas-paste path existed before this hook, and building it is out of scope
 * for formatted-text paste (todo.md №13).
 */
export function useCanvasPaste({ enabled, onPaste }: CanvasPasteOptions): void {
  useEffect(() => {
    if (!enabled) return;

    function handlePaste(e: ClipboardEvent) {
      // `closest` (attribute-based) instead of the `isContentEditable` DOM property:
      // jsdom doesn't compute that property from the attribute, which would make
      // this untestable, and the selector is exactly as correct in a real browser.
      // `e.target` is `Element` for a real paste, but can be `document`/`window`
      // for a paste with nothing focused (confirmed by the e2e run below) — guard
      // with `instanceof Element` before calling `closest`.
      const target = e.target;
      const inTextEntry =
        target instanceof Element && target.closest('[contenteditable="true"], textarea, input') != null;
      if (inTextEntry) return;

      const html = e.clipboardData?.getData("text/html") ?? "";
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!html.trim() && !text.trim()) return;

      e.preventDefault();
      onPaste({ html, text });
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [enabled, onPaste]);
}
