/**
 * URL of a managed asset served by the `myspace-asset` custom protocol
 * (registered in `src-tauri/src/lib.rs`).
 *
 * macOS (WKWebView) and Linux (WebKitGTK) load custom schemes directly as
 * `myspace-asset://localhost/<file>`. Windows (WebView2) cannot register a
 * custom scheme, so Tauri serves it as `http://myspace-asset.localhost/<file>`
 * instead. Rather than sniffing the user agent, the base is taken from Tauri's
 * own `convertFileSrc` (which knows the OS and the `useHttpsScheme` setting);
 * the file name is appended as-is, exactly as before, so the Rust handler sees
 * the same path on every platform. Outside Tauri (browser dev mode, e2e,
 * vitest) the custom-scheme form is used.
 */
export const ASSET_PROTOCOL = "myspace-asset";

const DEFAULT_ASSET_BASE = `${ASSET_PROTOCOL}://localhost/`;

type ConvertFileSrc = (filePath: string, protocol?: string) => string;

function tauriConvertFileSrc(): ConvertFileSrc | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { convertFileSrc?: ConvertFileSrc } })
    .__TAURI_INTERNALS__;
  return typeof internals?.convertFileSrc === "function" ? internals.convertFileSrc : undefined;
}

/** `myspace-asset://localhost/` or, on Windows, `http://myspace-asset.localhost/`. */
export function assetUrlBase(convert: ConvertFileSrc | undefined = tauriConvertFileSrc()): string {
  if (!convert) return DEFAULT_ASSET_BASE;
  try {
    const base = convert("", ASSET_PROTOCOL);
    return base.endsWith("/") ? base : `${base}/`;
  } catch {
    return DEFAULT_ASSET_BASE;
  }
}

export function assetUrl(filePath: string, base: string = assetUrlBase()): string {
  return `${base}${filePath}`;
}
