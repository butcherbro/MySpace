// Native file picker for importing an image asset. This isolates the
// `@tauri-apps/plugin-dialog` import (and any Tauri-specific behavior) from the
// rest of the UI, mirroring how the gateway isolates the Tauri IPC API.
import { fileNameFromPath } from "./platform-path";

/** Result of picking an image file, or null if the user cancelled. */
export interface PickedImage {
  path: string;
  fileName: string;
  mimeType: string;
}

/**
 * Opens the native file picker and returns the selected image, or `null` when
 * the user cancels. In a non-Tauri (browser) context this resolves to `null`
 * (there is no native dialog); browser tests inject their own path instead.
 */
export async function pickImageFile(): Promise<PickedImage | null> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return null;

  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"],
      },
    ],
  });

  if (!selected || Array.isArray(selected)) return null;

  return {
    path: selected,
    fileName: fileNameFromPath(selected),
    mimeType: mimeTypeFromName(selected),
  };
}

/**
 * Opens the native folder picker and returns the selected directory's path,
 * or `null` when the user cancels (todo.md №23, "Add Folder Shortcut…" on the
 * pane context menu). In a non-Tauri (browser) context this resolves to
 * `null` — there is no native dialog there, mirroring `pickImageFile` above.
 */
export async function pickFolder(): Promise<string | null> {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return null;

  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });

  if (!selected || Array.isArray(selected)) return null;
  return selected;
}

function mimeTypeFromName(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}
