/**
 * Suppresses the webview's built-in context menu ("Back / Reload / Save as /
 * Print / Inspect") everywhere except inside editable text, where the native
 * menu still provides copy, paste and spelling.
 *
 * WebKit on macOS never showed it for the canvas, WebView2 on Windows does,
 * which put a second menu on top of the app's own right-click menus.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(t);
  }
  return true;
}

export function installNativeContextMenuGuard(doc: Document = document): () => void {
  const handler = (event: MouseEvent) => {
    if (!isEditableTarget(event.target)) event.preventDefault();
  };
  doc.addEventListener("contextmenu", handler);
  return () => doc.removeEventListener("contextmenu", handler);
}
