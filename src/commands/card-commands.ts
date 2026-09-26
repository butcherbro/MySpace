// Card-specific workspace commands.

import type { CardsReceipt, Frame, WorkspaceGateway } from "../services/workspace-gateway";
import type { NoteColorId } from "../cards/note/note-color";
import { CommandConflictError, type WorkspaceCommand } from "./workspace-command";

interface MovedCard {
  id: string;
  revision: number;
  before: Frame;
  after: Frame;
}

/**
 * A drag/resize gesture over one or more cards. One gesture = one command and
 * one undo entry. `undo` re-moves cards back to their pre-gesture positions.
 *
 * The command owns card POSITION only: undo/redo read each card fresh, refuse
 * with `CommandConflictError` if it is no longer where this command left it,
 * and otherwise keep the card's current size and revision (text edits bump the
 * revision without going through the dispatcher).
 */
export class MoveCardsCommand implements WorkspaceCommand<CardsReceipt> {
  id: string;
  label = "Move";
  private undone = false;

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
    if (this.undone) {
      const receipt = await this.moveFrom(gateway, "redo", (m) => m.before, (m) => m.after);
      this.undone = false;
      return receipt;
    }
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
    await this.moveFrom(gateway, "undo", (m) => m.after, (m) => m.before);
    this.undone = true;
  }

  private async moveFrom(
    gateway: WorkspaceGateway,
    action: "undo" | "redo",
    from: (move: MovedCard) => Frame,
    to: (move: MovedCard) => Frame,
  ): Promise<CardsReceipt> {
    // Все чтения — до единственного moveCards: при конфликте не пишем ничего,
    // пакет остаётся атомарным.
    const current = await Promise.all(this.moves.map((m) => gateway.readCard(m.id)));
    const cards = this.moves.map((m, i) => {
      const card = current[i];
      if (!samePosition(card.frame, from(m))) throw new CommandConflictError(this.label, action);
      return {
        id: m.id,
        expectedRevision: card.revision,
        frame: withPosition(card.frame, to(m)),
      };
    });
    return this.applyReceipt(await gateway.moveCards({ cards }));
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

function samePosition(a: Frame, b: Frame): boolean {
  return a.x === b.x && a.y === b.y;
}

/** `frame` moved to `position`'s x/y; keeps `frame`'s size. */
function withPosition(frame: Frame, position: Frame): Frame {
  return { ...frame, x: position.x, y: position.y };
}

/**
 * Moves a leaf card (note/image/embed) to another board at an exact frame.
 * `undo` moves it back to its source board and original position. One move =
 * one undo entry, matching how Board moves are already undoable. Undo/redo
 * follow the same position-only conflict rule as `MoveCardsCommand`.
 */
export class MoveCardToBoardCommand implements WorkspaceCommand {
  id: string;
  label = "Move to board";
  private undone = false;

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
    if (this.undone) {
      await this.moveFrom(gateway, "redo", this.sourceBoardId, this.sourceFrame, this.targetBoardId, this.targetFrame);
      this.undone = false;
      return;
    }
    const receipt = await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: this.currentRevision,
      targetBoardId: this.targetBoardId,
      frame: this.targetFrame,
    });
    this.currentRevision = receipt.revision;
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await this.moveFrom(gateway, "undo", this.targetBoardId, this.targetFrame, this.sourceBoardId, this.sourceFrame);
    this.undone = true;
  }

  private async moveFrom(
    gateway: WorkspaceGateway,
    action: "undo" | "redo",
    fromBoardId: string,
    fromFrame: Frame,
    toBoardId: string,
    toFrame: Frame,
  ): Promise<void> {
    const card = await gateway.readCard(this.cardId);
    if (card.boardId !== fromBoardId || !samePosition(card.frame, fromFrame)) {
      throw new CommandConflictError(this.label, action);
    }
    const receipt = await gateway.moveCardToBoard({
      id: this.cardId,
      expectedRevision: card.revision,
      targetBoardId: toBoardId,
      frame: withPosition(card.frame, toFrame),
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
