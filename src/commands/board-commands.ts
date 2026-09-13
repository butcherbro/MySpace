// Board-specific workspace commands.

import type {
  CreateChildBoardInput,
  Frame,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

/** Creates a child board + portal. `undo` trashes the board (and its portal). */
export class CreateChildBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Create board";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private input: CreateChildBoardInput,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return;
    }
    await gateway.createChildBoard(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashBoard(this.input.boardId);
  }
}

/** Renames a board. `undo` restores the previous title. */
export class RenameBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Rename board";

  constructor(
    id: string,
    private boardId: string,
    private nextTitle: string,
    private prevTitle: string,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.renameBoard(this.boardId, this.nextTitle);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.renameBoard(this.boardId, this.prevTitle);
  }
}

/**
 * Moves a Board to a new parent. `undo` reparents it back to the previous
 * parent and frame; both directions use the same `moveBoard` domain command and
 * carry the post-operation revisions so the inverse is revision-correct.
 */
export class MoveBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Move board";

  constructor(
    id: string,
    private boardId: string,
    private prevParentBoardId: string,
    private prevFrame: Frame,
    private nextParentBoardId: string,
    private nextFrame: Frame,
    private boardRevision: number,
    private portalRevision: number,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.moveBoard({
      boardId: this.boardId,
      expectedBoardRevision: this.boardRevision,
      expectedPortalRevision: this.portalRevision,
      targetParentBoardId: this.nextParentBoardId,
      frame: this.nextFrame,
    });
    this.boardRevision += 1;
    this.portalRevision += 1;
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.moveBoard({
      boardId: this.boardId,
      expectedBoardRevision: this.boardRevision,
      expectedPortalRevision: this.portalRevision,
      targetParentBoardId: this.prevParentBoardId,
      frame: this.prevFrame,
    });
    this.boardRevision += 1;
    this.portalRevision += 1;
  }
}

/**
 * Moves a whole selection — leaf cards and Board Portals together — in one atomic
 * backend call, and reverses it from the receipt that call returned (ADR-0007).
 * The receipt is the undo's input, so neither direction guesses revisions or
 * frames, and a partially applied selection cannot be produced.
 */
export class MoveSelectionCommand implements WorkspaceCommand {
  id: string;
  label = "Move selection";
  private receipt: import("../services/workspace-gateway").MoveSelectionToBoardReceipt | null = null;

  constructor(
    id: string,
    private input: import("../services/workspace-gateway").MoveSelectionToBoardInput,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    this.receipt = await gateway.moveSelectionToBoard(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    if (!this.receipt) {
      throw new Error("move selection cannot be undone before it ran");
    }
    await gateway.undoMoveSelection(this.receipt);
  }
}
