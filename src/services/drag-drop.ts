// Native file drop: listens for the Tauri `tauri://drag-drop` window event and
// maps it to application-owned data (paths + position). This isolates the Tauri
// event API from the UI, mirroring how the gateway isolates IPC.

/** A file dropped onto the window. */
export interface DroppedFile {
  path: string;
  fileName: string;
  mimeType: string;
}

/** The current cursor position (screen/window coordinates) and dropped files. */
export interface DropPayload {
  paths: string[];
  x: number;
  y: number;
}

/** Extracts a filename from a path. */
function fileNameFromPath(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Derives a MIME type from a file extension. */
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

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"];

function isImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

/**
 * Subscribes to native file drops, invoking `onDrop` whenever one or more image
 * files land on the window. Returns an unsubscribe function. In a non-Tauri
 * (browser) context this is a no-op returning a no-op unsubscriber.
 */
export function subscribeToImageDrops(onDrop: (files: DroppedFile[], x: number, y: number) => void): () => void {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) {
    return () => {};
  }

  let unlisten: (() => void) | null = null;

  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<DropPayload>("tauri://drag-drop", (event) => {
      const files = (event.payload.paths ?? [])
        .filter(isImageFile)
        .map((p) => ({ path: p, fileName: fileNameFromPath(p), mimeType: mimeTypeFromName(p) }));
      if (files.length > 0) {
        onDrop(files, event.payload.x, event.payload.y);
      }
    }).then((fn) => {
      unlisten = fn;
    });
  });

  return () => {
    unlisten?.();
  };
}
