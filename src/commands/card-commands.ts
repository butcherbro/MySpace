// Card-specific workspace commands.

import type { Frame, WorkspaceGateway } from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

interface MovedCard {
  id: string;
  revision: number;
  before: Frame;
  after: Frame;
}

/**
 * A drag/resize gesture over one or more cards. One gesture = one command and
 * one undo entry. `undo` re-moves cards back to their pre-gesture frames.
 */
export class MoveCardsCommand implements WorkspaceCommand {
  id: string;
  label = "Move";

  constructor(
    id: string,
    private moves: MovedCard[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.moveCards({
      cards: this.moves.map((m) => ({
        id: m.id,
        expectedRevision: m.revision,
        frame: m.after,
      })),
    });
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    // Reverse: move every card back to its prior frame, using the post-move
    // revision (the move bumped each card's revision by one).
    await gateway.moveCards({
      cards: this.moves.map((m) => ({
        id: m.id,
        expectedRevision: m.revision + 1,
        frame: m.before,
      })),
    });
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/** Creates a note card. `undo` trashes it. */
export class CreateNoteCommand implements WorkspaceCommand {
  id: string;
  label = "Create note";

  constructor(
    id: string,
    private input: Parameters<WorkspaceGateway["createNote"]>[0],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.createNote(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.trashNote(this.input.id);
  }
}

/**
 * Moves a leaf card (note/image/embed) to another board at an exact frame.
 * `undo` moves it back to its source board and original frame. One move = one
 * undo entry, matching how Board moves are already undoable.
 */
export class MoveCardToBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Move to board";

  constructor(
    id: string,
    private cardId: string,
    private sourceBoardId: string,
    private sourceFrame: Frame,
    private sourceRevision: number,
    private targetBoardId: string,
    private targetFrame: Frame,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: this.sourceRevision,
      targetBoardId: this.targetBoardId,
      frame: this.targetFrame,
    });
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    // The move bumped the card's revision by one; move it back to the source
    // board at its original frame.
    await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: this.sourceRevision + 1,
      targetBoardId: this.sourceBoardId,
      frame: this.sourceFrame,
    });
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}
