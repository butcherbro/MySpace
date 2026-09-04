// Trash-related workspace commands.

import type { WorkspaceGateway } from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

export interface TrashItem {
  /** The card id for leaf cards (note/image/embed), or the target board id for portals. */
  id: string;
  kind: "note" | "image" | "embed" | "board_portal";
}

/**
 * Trashes the current selection. Notes are soft-deleted individually; portals
 * are treated as explicit board-deletion (their whole subtree moves to Trash).
 * `undo` restores every batch.
 */
export class TrashSelectionCommand implements WorkspaceCommand {
  id: string;
  label = "Move to Trash";
  private batchIds: string[] = [];

  constructor(
    id: string,
    private items: TrashItem[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    for (const item of this.items) {
      if (item.kind === "board_portal") {
        const batch = await gateway.trashBoard(item.id);
        this.batchIds.push(batch);
      } else {
        // note / image / embed all share the leaf-card trash path.
        const batch = await gateway.trashNote(item.id);
        this.batchIds.push(batch);
      }
    }
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    for (const batch of this.batchIds) {
      await gateway.restoreTrashBatch(batch);
    }
  }
}
