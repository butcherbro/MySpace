// Trash-related workspace commands.

import type { WorkspaceGateway } from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

export interface TrashItem {
  /** The card id for leaf cards, or the target board id for portals. */
  id: string;
  kind: "note" | "image" | "embed" | "filesystem_alias" | "board_portal" | "file" | "board_shortcut";
}

/**
 * Trashes the current selection. Notes are soft-deleted individually; portals
 * are treated as explicit board-deletion (their whole subtree moves to Trash).
 * `undo` restores every batch.
 */
export class TrashSelectionCommand implements WorkspaceCommand {
  id: string;
  label = "Move to Trash";
  private batchId: string | null = null;

  constructor(
    id: string,
    private items: TrashItem[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    // One atomic backend call: a single transaction and a single batch id, so a
    // partial trash can never occur and undo restores the whole selection.
    this.batchId = await gateway.trashSelection({ items: this.items });
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    if (this.batchId) {
      await gateway.restoreTrashBatch(this.batchId);
    }
  }
}
