import { useEffect, type RefObject } from "react";
import {
  routeNativeDropItems,
  subscribeToNativeDrops,
} from "../services/drag-drop";
import type { CardDto, WorkspaceGateway } from "../services/workspace-gateway";

/**
 * Native (Finder) file drop controller.
 *
 * Rust classifies the dropped paths before the WebView creates anything, so this
 * hook only decides where the Cards land: convert the cursor's screen position
 * into canvas coordinates, and fall back to a cascading default when the canvas
 * is not ready to convert yet (a drop right after the board loads).
 *
 * Extracted from `App.tsx` unchanged (Task 17, extraction 3 of 6): same
 * conversion, same default offset, same per-kind adaptation, same failure path
 * to the error banner.
 */

export interface NativeFileDropOptions {
  gateway: WorkspaceGateway;
  /** The canvas conversion, absent until the canvas instance registers it. */
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  /** The open board's cards, used for the cascading default position. */
  cardsRef: RefObject<ReadonlyArray<CardDto>>;
  onCreateFolder: (path: string, x: number, y: number) => Promise<void>;
  onCreateImage: (
    path: string,
    fileName: string,
    mimeType: string,
    x: number,
    y: number,
  ) => Promise<void>;
  onCreateFile: (
    item: { path: string; fileName: string; mimeType: string },
    x: number,
    y: number,
  ) => Promise<void>;
  onError: (message: string) => void;
}

export function useNativeFileDrop(options: NativeFileDropOptions): void {
  const {
    gateway,
    screenToFlowRef,
    cardsRef,
    onCreateFolder,
    onCreateImage,
    onCreateFile,
    onError,
  } = options;

  useEffect(() => {
    return subscribeToNativeDrops((paths, x, y) => {
      const screenToFlow = screenToFlowRef.current;
      let flowX = 80;
      let flowY = 80 + cardsRef.current.length * 24;
      if (screenToFlow && Number.isFinite(x) && Number.isFinite(y)) {
        const flow = screenToFlow(x, y);
        if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
          flowX = flow.x;
          flowY = flow.y;
        }
      }
      void routeNativeDropItems({
        gateway,
        paths,
        origin: { x: flowX - 180, y: flowY - 150 },
        onFolder: (item, point) => onCreateFolder(item.path, point.x, point.y),
        onImage: (item, point) =>
          onCreateImage(
            item.path,
            item.fileName,
            item.mimeType ?? "application/octet-stream",
            point.x + 20,
            point.y + 30,
          ),
        onFile: (item, point) =>
          onCreateFile(
            {
              path: item.path,
              fileName: item.fileName ?? "file",
              mimeType: item.mimeType ?? "text/plain",
            },
            point.x,
            point.y,
          ),
      }).catch((e) => {
        onError(e instanceof Error ? e.message : String(e));
      });
    });
  // The two refs are stable (they belong to the caller), so including them keeps
  // the subscription in place; they are read at drop time, not at subscribe time.
  }, [cardsRef, gateway, onError, onCreateFile, onCreateFolder, onCreateImage, screenToFlowRef]);
}
