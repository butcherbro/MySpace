/**
 * Path helpers that work for macOS/Linux (`/`) and Windows (`\`, drive letters,
 * UNC shares) paths alike. Paths only ever reach the WebView as display text or
 * as opaque arguments handed back to Rust, so this never resolves anything.
 */

/** Last path component (`C:\Docs\a.pdf` → `a.pdf`, `/Users/x/dir/` → `dir`). */
export function fileNameFromPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Windows drive-absolute (`C:\…`, `C:/…`) or UNC (`\\server\share…`) path. */
export function isWindowsAbsolutePath(text: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(text);
}

/**
 * Explorer's "Copy as path" wraps the path in double quotes; strip one
 * surrounding pair so `"C:\Users\x\file.txt"` is recognised as a path.
 */
export function stripWrappingQuotes(text: string): string {
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}
