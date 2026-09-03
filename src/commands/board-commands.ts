// Board-specific workspace commands.

import type {
  CreateChildBoardInput,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

/** Creates a child board + portal. `undo` trashes the board (and its portal). */
export class CreateChildBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Create board";

  constructor(
    id: string,
    private input: CreateChildBoardInput,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.createChildBoard(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.trashBoard(this.input.boardId);
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
