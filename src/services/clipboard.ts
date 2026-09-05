// Clipboard access for "Copy MySpace Link" / "Copy File Path". The Tauri build
// writes through a backend `copy_text_command` (NSPasteboard on macOS) so the
// WKWebView never depends on the flaky `navigator.clipboard` secure-context
// dance. Outside Tauri (browser/tests) we fall back to the Web Clipboard API.

export async function copyText(text: string): Promise<void> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("copy_text_command", { text });
    return;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error("Clipboard is unavailable in this environment");
}
