// Card-specific workspace commands.

import type { CardsReceipt, Frame, WorkspaceGateway } from "../services/workspace-gateway";
import type { NoteColorId } from "../cards/note/note-color";
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
export class MoveCardsCommand implements WorkspaceCommand<CardsReceipt> {
  id: string;
  label = "Move";

  constructor(
    id: string,
    private moves: MovedCard[],
  ) {
    this.id = id;
  }

  private applyReceipt(receipt: CardsReceipt): CardsReceipt {
    const revisionById = new Map(receipt.cards.map((c) => [c.id, c.revision]));
    this.moves = this.moves.map((move) => {
      const revision = revisionById.get(move.id);
      // unreachable: the backend returns exactly one CardReceipt per requested card
      return revision === undefined ? move : { ...move, revision };
    });
    return receipt;
  }

  async execute(gateway: WorkspaceGateway): Promise<CardsReceipt> {
    const receipt = await gateway.moveCards({
      cards: this.moves.map((m) => ({
        id: m.id,
        expectedRevision: m.revision,
        frame: m.after,
      })),
    });
    return this.applyReceipt(receipt);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    // Reverse: move every card back to its prior frame, using the post-move
    // revision (the move bumped each card's revision by one).
    const receipt = await gateway.moveCards({
      cards: this.moves.map((m) => ({
        id: m.id,
        expectedRevision: m.revision,
        frame: m.before,
      })),
    });
    this.applyReceipt(receipt);
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/** Creates a note card. `undo` trashes it. */
export class CreateNoteCommand implements WorkspaceCommand {
  id: string;
  label = "Create note";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private input: Parameters<WorkspaceGateway["createNote"]>[0],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return;
    }
    await gateway.createNote(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashNote(this.input.id);
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
    private currentRevision: number,
    private targetBoardId: string,
    private targetFrame: Frame,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    const receipt = await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: this.currentRevision,
      targetBoardId: this.targetBoardId,
      frame: this.targetFrame,
    });
    this.currentRevision = receipt.revision;
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    // The move bumped the card's revision; move it back to the source board at
    // its original frame using the revision the backend just returned.
    const receipt = await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: this.currentRevision,
      targetBoardId: this.sourceBoardId,
      frame: this.sourceFrame,
    });
    this.currentRevision = receipt.revision;
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/** Sets a note card's background color preset. `undo` restores the previous color. */
export class SetNoteColorCommand implements WorkspaceCommand {
  id: string;
  label = "Change note color";

  constructor(
    id: string,
    private cardId: string,
    private nextColor: NoteColorId,
    private prevColor: NoteColorId,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    await gateway.setNoteColor({ id: this.cardId, colorToken: this.nextColor });
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.setNoteColor({ id: this.cardId, colorToken: this.prevColor });
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/** Creates an image card (reusing an existing asset id). `undo` trashes it. */
export class CreateImageCardCommand implements WorkspaceCommand {
  id: string;
  label = "Create image";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private input: Parameters<WorkspaceGateway["createImageCard"]>[0],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return;
    }
    await gateway.createImageCard(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashSelection({
      items: [{ id: this.input.id, kind: "image" }],
    });
  }
}
