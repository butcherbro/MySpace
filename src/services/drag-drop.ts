import type { DropPathClassificationDto } from "./workspace-gateway";

/** The current cursor position (screen/window coordinates) and dropped paths.
 * Tauri v2 delivers `{ paths, position: { x, y } }`. */
export interface DropPayload {
  paths: string[];
  position: { x: number; y: number };
}

type DropClassifier = {
  classifyDropPaths(paths: string[]): Promise<DropPathClassificationDto[]>;
};

interface RouteNativeDropItemsInput {
  gateway: DropClassifier;
  paths: string[];
  origin: { x: number; y: number };
  onFolder: (item: DropPathClassificationDto, point: { x: number; y: number }) => Promise<void>;
  onImage: (item: DropPathClassificationDto, point: { x: number; y: number }) => Promise<void>;
  onFile: (item: DropPathClassificationDto, point: { x: number; y: number }) => Promise<void>;
}

/** Classifies native paths in Rust and preserves source order with a small fan-out offset. */
export async function routeNativeDropItems({
  gateway,
  paths,
  origin,
  onFolder,
  onImage,
  onFile,
}: RouteNativeDropItemsInput): Promise<void> {
  const items = await gateway.classifyDropPaths(paths);
  let placedIndex = 0;
  for (const item of items) {
    if (item.kind === "unsupported") continue;
    const point = { x: origin.x + placedIndex * 18, y: origin.y + placedIndex * 18 };
    placedIndex += 1;
    if (item.kind === "folder") await onFolder(item, point);
    else if (
      item.kind === "text_file" ||
      item.kind === "archive" ||
      item.kind === "office_file"
    )
      await onFile(item, point);
    else await onImage(item, point);
  }
}

/**
 * Subscribes to the native Tauri drop event without classifying paths in the
 * WebView. Rust owns folder/file checks so Finder folders are not filtered out.
 */
export function subscribeToNativeDrops(
  onDrop: (paths: string[], x: number, y: number) => void,
): () => void {
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!isTauri) return () => {};

  // Registration is asynchronous: the dynamic import and `listen` both settle on
  // later turns. Cleanup can therefore run first, and naively storing the unlisten
  // function when it arrives would leak a live listener that still delivers drops.
  let disposed = false;
  let unlisten: (() => void) | null = null;

  const register = async (): Promise<void> => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<DropPayload>("tauri://drag-drop", (event) => {
        // A listener that outlived its subscription must not deliver.
        if (disposed) return;
        const paths = event.payload.paths ?? [];
        const x = event.payload.position?.x;
        const y = event.payload.position?.y;
        if (paths.length > 0) onDrop(paths, x, y);
      });
      if (disposed) {
        // Cleanup already ran, so this late listener is torn down immediately.
        stop();
        return;
      }
      unlisten = stop;
    } catch {
      // A missing module or a denied listen leaves no listener; it must not
      // surface as an unhandled rejection either.
      unlisten = null;
    }
  };

  void register();

  return () => {
    if (disposed) return;
    disposed = true;
    const stop = unlisten;
    unlisten = null;
    stop?.();
  };
}
