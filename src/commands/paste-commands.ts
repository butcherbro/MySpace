// Paste-cards workspace command (todo.md №15): one dispatcher entry for a
// whole pasted group, so Cmd+Z undoes every duplicate at once.

import type { Frame, WorkspaceGateway } from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

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

export type PasteCardSpec = PasteNoteSpec | PasteImageSpec;

/**
 * Creates a group of pasted cards (notes/images) as one gesture. Notes carry
 * their documentJson/plainText plus a follow-up color write (creation itself
 * has no color field); images reuse the source asset id — several cards can
 * point at one asset, and the backend GC already counts owners by
 * `image_cards.asset_id`, so this never risks deleting a shared asset.
 *
 * `undo` trashes every created card in a single batch (one Trash entry, one
 * restore), matching `TrashSelectionCommand`.
 */
export class PasteCardsCommand implements WorkspaceCommand {
  id: string;
  label = "Paste";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private specs: PasteCardSpec[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return;
    }
    for (const spec of this.specs) {
      if (spec.kind === "note") {
        await gateway.createNote({
          id: spec.id,
          boardId: spec.boardId,
          frame: spec.frame,
          zIndex: spec.zIndex,
          documentJson: spec.documentJson,
          plainText: spec.plainText,
        });
        if (spec.colorToken !== "default") {
          await gateway.setNoteColor({ id: spec.id, colorToken: spec.colorToken });
        }
      } else {
        await gateway.createImageCard({
          id: spec.id,
          boardId: spec.boardId,
          frame: spec.frame,
          zIndex: spec.zIndex,
          assetId: spec.assetId,
          captionJson: spec.captionJson,
          captionPlainText: spec.captionPlainText,
        });
      }
    }
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashSelection({
      items: this.specs.map((s) => ({ id: s.id, kind: s.kind })),
    });
  }
}
