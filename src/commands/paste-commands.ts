// Paste-cards workspace command (todo.md №15): one dispatcher entry for a
// whole pasted group, so Cmd+Z undoes every duplicate at once.

import type { BoardPortalDto, BoardShortcutDto, Frame, WorkspaceGateway } from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";
import type { TrashItem } from "./trash-commands";

export interface PasteNoteSpec {
  kind: "note";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  documentJson: unknown;
  plainText: string;
  colorToken: string;
}

export interface PasteImageSpec {
  kind: "image";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  /** Copy-in model: the pasted card points at the same asset as the source. */
  assetId: string;
  captionJson: unknown;
  captionPlainText: string;
}

/**
 * A copied Board Portal (todo.md №16): pasting it runs the same atomic
 * `duplicateBoard` backend call the "Duplicate" context-menu action uses.
 * `id` is the new portal card's id; `newBoardId` is the new board's id — both
 * frontend-generated, matching every other spec's `id` field. `sourceBoardId`
 * is the portal's own target, not the copied portal's id.
 */
export interface PasteBoardSpec {
  kind: "board";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  sourceBoardId: string;
  newBoardId: string;
}

/**
 * A copied board shortcut (todo.md №17): pasting it is a plain
 * `createBoardShortcut` call pointing at the same target — no recursion, no
 * new board id, unlike `PasteBoardSpec`.
 */
export interface PasteShortcutSpec {
  kind: "shortcut";
  id: string;
  boardId: string;
  frame: Frame;
  zIndex: number;
  targetBoardId: string;
}

export type PasteCardSpec = PasteNoteSpec | PasteImageSpec | PasteBoardSpec | PasteShortcutSpec;

/**
 * Maps a paste spec's own `kind` (which names the clipboard shape, e.g.
 * "board" for a duplicated Board Portal) to the `TrashItem` kind its created
 * card/board is trashed as on undo — a registry lookup in place of a
 * hand-written switch, kept alongside `PasteCardSpec` since the two kind
 * vocabularies (spec-shape vs. persisted card kind) only line up here.
 */
const PASTE_KIND_TO_TRASH_KIND: Record<PasteCardSpec["kind"], TrashItem["kind"]> = {
  note: "note",
  image: "image",
  board: "board_portal",
  shortcut: "board_shortcut",
};

/**
 * Creates a group of pasted cards (notes/images/board duplicates) as one
 * gesture. Notes carry their documentJson/plainText plus a follow-up color
 * write (creation itself has no color field); images reuse the source asset
 * id — several cards can point at one asset, and the backend GC already
 * counts owners by `image_cards.asset_id`, so this never risks deleting a
 * shared asset. A board spec's copy is itself atomic and recursive
 * (ADR-0009); its resulting portal DTO is returned from `execute` so the
 * caller can place it on the canvas with the backend-assigned title/counts,
 * which — unlike a note/image — cannot be predicted client-side.
 *
 * `undo` trashes every created card/board in a single batch (one Trash entry,
 * one restore), matching `TrashSelectionCommand`. A board spec contributes
 * `{ id: newBoardId, kind: "board_portal" }`, the same shape
 * `handleDeleteSelection` already sends for a live portal — `trashSelection`
 * resolves a `"board_portal"` item by board id, not portal card id.
 */
export interface PasteCardsResult {
  portals: BoardPortalDto[];
  /** Pasted shortcuts (todo.md №17), same reasoning as `portals`: the
   * target board's live identity is backend-assigned, not client-predicted. */
  shortcuts: BoardShortcutDto[];
}

export class PasteCardsCommand implements WorkspaceCommand<PasteCardsResult> {
  id: string;
  label = "Paste";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private specs: PasteCardSpec[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<PasteCardsResult> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return { portals: [], shortcuts: [] };
    }
    const portals: BoardPortalDto[] = [];
    const shortcuts: BoardShortcutDto[] = [];
    for (const spec of this.specs) {
      if (spec.kind === "note") {
        await gateway.createNote({
          id: spec.id,
          boardId: spec.boardId,
          frame: spec.frame,
          zIndex: spec.zIndex,
          documentJson: spec.documentJson,
        });
        if (spec.colorToken !== "default") {
          await gateway.setNoteColor({ id: spec.id, colorToken: spec.colorToken });
        }
      } else if (spec.kind === "image") {
        await gateway.createImageCard({
          id: spec.id,
          boardId: spec.boardId,
          frame: spec.frame,
          zIndex: spec.zIndex,
          assetId: spec.assetId,
          captionJson: spec.captionJson,
        });
      } else if (spec.kind === "shortcut") {
        const created = await gateway.createBoardShortcut({
          id: spec.id,
          boardId: spec.boardId,
          frame: spec.frame,
          zIndex: spec.zIndex,
          targetBoardId: spec.targetBoardId,
        });
        shortcuts.push(created);
      } else {
        const receipt = await gateway.duplicateBoard({
          sourceBoardId: spec.sourceBoardId,
          targetBoardId: spec.boardId,
          newBoardId: spec.newBoardId,
          newPortalCardId: spec.id,
          frame: spec.frame,
        });
        portals.push(receipt.portal);
      }
    }
    return { portals, shortcuts };
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashSelection({
      items: this.specs.map((s) => ({
        id: s.kind === "board" ? s.newBoardId : s.id,
        kind: PASTE_KIND_TO_TRASH_KIND[s.kind],
      })),
    });
  }
}
