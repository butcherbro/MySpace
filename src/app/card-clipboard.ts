// Internal in-memory card clipboard (todo.md №15).
//
// Copy/paste of cards (notes, images) stays inside the app's own process, not
// the system pasteboard: WKWebView's Clipboard API only round-trips the
// well-known types (text/plain, text/html, image/png) — a custom mime type
// like `web application/x-myspace-cards+json` is rejected by
// `navigator.clipboard.write` (ClipboardItem only accepts a browser-approved
// whitelist), so there is no reliable way to stash structured card data on
// the system pasteboard and read it back. A module-level variable is the V1
// answer: it survives across a copy/paste within one window, which is the
// stated scope, and it never touches the system clipboard, so it cannot
// collide with or clobber the existing image-to-system-clipboard copy
// (`copyImageCards`, `gateway.copyImageCards`) or the text/html canvas-paste
// path (`use-canvas-paste.ts`).
//
// The buffer holds *relative* positions (offset from the copied group's
// top-left) so paste can re-place the whole group under the cursor while
// preserving their layout.

import type { AssetDto, Frame } from "../services/workspace-gateway";
import type { PasteCardSpec } from "../commands/paste-commands";

/**
 * A copied Board Portal (todo.md №16). Unlike a note/image, there is no
 * content to snapshot here — the backend's `duplicateBoard` reads the source
 * board's live content itself (ADR-0009), so the clipboard only needs to
 * remember which board to duplicate and the portal's own on-screen size.
 */
export interface CopiedBoardCard {
  kind: "board";
  dx: number;
  dy: number;
  width: number;
  height: number;
  sourceBoardId: string;
}

export interface CopiedNoteCard {
  kind: "note";
  dx: number;
  dy: number;
  width: number;
  height: number;
  documentJson: unknown;
  plainText: string;
  colorToken: string;
}

export interface CopiedImageCard {
  kind: "image";
  dx: number;
  dy: number;
  width: number;
  height: number;
  /** Copy-in model: the paste reuses this asset id, it never duplicates the file. */
  asset: AssetDto;
  captionJson: unknown;
  captionPlainText: string;
}

/**
 * A copied board shortcut (todo.md №17): pasting it creates a new shortcut
 * pointing at the SAME target board — never the source shortcut's own id, and
 * never remapped even if the source's target happens to be part of the
 * current selection (see docs/decisions/0010-board-shortcuts.md).
 */
export interface CopiedShortcutCard {
  kind: "shortcut";
  dx: number;
  dy: number;
  width: number;
  height: number;
  targetBoardId: string;
}

export type CopiedCard = CopiedNoteCard | CopiedImageCard | CopiedBoardCard | CopiedShortcutCard;

let buffer: CopiedCard[] | null = null;

/** Replaces the buffer. An empty array clears it (nothing worth pasting). */
export function setCardClipboard(cards: CopiedCard[]): void {
  buffer = cards.length > 0 ? cards : null;
}

export function readCardClipboard(): CopiedCard[] | null {
  return buffer;
}

/** Test-only: reset module state between specs. */
export function clearCardClipboard(): void {
  buffer = null;
}

/**
 * Places a copied group under `cursor` (board-space), preserving the group's
 * relative layout (each card keeps its `dx`/`dy` offset from the group's
 * original top-left). Pure — the caller supplies fresh ids and the target
 * board, so this is safe to unit-test without any gateway/dispatcher.
 */
export function buildPasteSpecs(
  copied: CopiedCard[],
  cursor: { x: number; y: number },
  boardId: string,
  baseZIndex: number,
  nextId: () => string,
): PasteCardSpec[] {
  return copied.map((c, index) => {
    const frame: Frame = {
      x: cursor.x + c.dx,
      y: cursor.y + c.dy,
      width: c.width,
      height: c.height,
    };
    const id = nextId();
    const zIndex = baseZIndex + index;
    if (c.kind === "note") {
      return {
        kind: "note" as const,
        id,
        boardId,
        frame,
        zIndex,
        documentJson: c.documentJson,
        plainText: c.plainText,
        colorToken: c.colorToken,
      };
    }
    if (c.kind === "image") {
      return {
        kind: "image" as const,
        id,
        boardId,
        frame,
        zIndex,
        assetId: c.asset.id,
        captionJson: c.captionJson,
        captionPlainText: c.captionPlainText,
      };
    }
    if (c.kind === "shortcut") {
      return {
        kind: "shortcut" as const,
        id,
        boardId,
        frame,
        zIndex,
        targetBoardId: c.targetBoardId,
      };
    }
    return {
      kind: "board" as const,
      id,
      boardId,
      frame,
      zIndex,
      sourceBoardId: c.sourceBoardId,
      newBoardId: nextId(),
    };
  });
}
