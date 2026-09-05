// Native URL opener to the OS default browser. Isolates the
// `@tauri-apps/plugin-opener` import (and the browser fallback) from the rest of
// the UI, mirroring how `asset-picker.ts` isolates the dialog plugin.

/**
 * Opens an external URL in the system default browser. Only `http`/`https`
 * schemes are allowed; anything else is a no-op so a stray `file://` or
 * `javascript:` link (e.g. pasted maliciously) can never navigate the WebView.
 */
export async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return;
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) {
    // Browser (Playwright / manual web preview): open in a new tab. This keeps
    // the e2e/dev experience functional without Tauri's native shell.
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
