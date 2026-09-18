import { useEffect } from "react";

export interface CanvasPasteData {
  html: string;
  text: string;
}

export interface CanvasPasteOptions {
  /** Paste is a no-op when no board is open. */
  enabled: boolean;
  onPaste: (data: CanvasPasteData) => void;
  /**
   * Checked first, before text/html: pastes the internal card clipboard
   * (todo.md №15) if it holds anything. Returns whether it handled the paste.
   */
  onPasteCards?: () => boolean;
  /**
   * Checked second, before text/html: a single-line clipboard text that looks
   * like a filesystem path (`/…` or `~/…`, todo.md №23). Resolves to whether
   * it was handled (an existing folder/file became a shortcut/file card) — a
   * missing path resolves `false`, and the paste falls through to the normal
   * text/html note below.
   */
  onPastePath?: (path: string) => Promise<boolean>;
}

/**
 * A single-line clipboard string shaped like an absolute or home-relative
 * filesystem path. Multi-line text is never a path candidate — even one that
 * starts with `/` — so a copied code snippet or log excerpt keeps going to
 * the normal note paste instead of a (failed) existence check.
 */
export function extractPathCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.includes("\n") || trimmed.includes("\r")) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed === "~") return trimmed;
  return null;
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
export function useCanvasPaste({ enabled, onPaste, onPasteCards, onPastePath }: CanvasPasteOptions): void {
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

      // Our own card clipboard wins whenever it holds anything: it is only
      // ever populated by this app's own Cmd+C, so it is always the more
      // specific, more recent intent than whatever text/html happens to sit
      // on the system pasteboard.
      if (onPasteCards && onPasteCards()) {
        e.preventDefault();
        return;
      }

      const html = e.clipboardData?.getData("text/html") ?? "";
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!html.trim() && !text.trim()) return;

      // A path candidate is checked before the plain text/html paste below,
      // but only a *missing* path falls through to it — an existing
      // folder/file is consumed here and must not also become a note.
      const pathCandidate = onPastePath ? extractPathCandidate(text) : null;
      if (pathCandidate) {
        e.preventDefault();
        void onPastePath!(pathCandidate).then((handled) => {
          if (!handled) onPaste({ html, text });
        });
        return;
      }

      e.preventDefault();
      onPaste({ html, text });
    }

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [enabled, onPaste, onPasteCards, onPastePath]);
}
