// Card-specific workspace commands.

import type {
  CardDto,
  CardsReceipt,
  FileCardDto,
  FilesystemAliasDto,
  Frame,
  WorkspaceGateway,
} from "../services/workspace-gateway";
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

// Дробные координаты проходят JSON → Rust (serde_json без float_roundtrip) и
// обратно, и последний бит может не совпасть. Сотая доля пикселя — не движение.
const POSITION_EPSILON = 0.01;

function samePosition(a: Frame, b: Frame): boolean {
  return Math.abs(a.x - b.x) < POSITION_EPSILON && Math.abs(a.y - b.y) < POSITION_EPSILON;
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

/**
 * Creates a folder shortcut card. `undo` trashes it; redo restores the trash
 * batch (like `CreateImageCardCommand`), so the card keeps its id and the
 * device-local bookmark row.
 */
export class CreateFolderShortcutCommand implements WorkspaceCommand<FilesystemAliasDto | null> {
  id: string;
  label = "Create folder shortcut";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private input: Parameters<WorkspaceGateway["createFolderAlias"]>[0],
  ) {
    this.id = id;
  }

  /** The created card on the first run; `null` on redo (the board reloads). */
  async execute(gateway: WorkspaceGateway): Promise<FilesystemAliasDto | null> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return null;
    }
    return gateway.createFolderAlias(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashSelection({
      items: [{ id: this.input.id, kind: "filesystem_alias" }],
    });
  }
}

/** Creates a File Card. `undo` trashes it; redo restores the trash batch. */
export class CreateFileCardCommand implements WorkspaceCommand<FileCardDto | null> {
  id: string;
  label = "Create file card";
  private trashBatchId: string | null = null;

  constructor(
    id: string,
    private input: Parameters<WorkspaceGateway["createFileCard"]>[0],
  ) {
    this.id = id;
  }

  /** The created card on the first run; `null` on redo (the board reloads). */
  async execute(gateway: WorkspaceGateway): Promise<FileCardDto | null> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      return null;
    }
    return gateway.createFileCard(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    this.trashBatchId = await gateway.trashSelection({
      items: [{ id: this.input.id, kind: "file" }],
    });
  }
}

/** Which card text an {@link EditCardTextCommand} owns. */
export type TextCardKind = "note" | "image" | "embed";

const TEXT_FIELDS: Record<
  TextCardKind,
  {
    label: string;
    read: (card: CardDto) => { document: unknown; corrupt?: boolean } | null;
    write: (gateway: WorkspaceGateway, id: string, expectedRevision: number, document: unknown) => Promise<unknown>;
  }
> = {
  note: {
    label: "Edit note",
    read: (card) => (card.kind === "note" ? { document: card.documentJson, corrupt: card.corrupt } : null),
    write: (gateway, id, expectedRevision, documentJson) =>
      gateway.updateNote({ id, expectedRevision, documentJson }),
  },
  image: {
    label: "Edit caption",
    read: (card) => (card.kind === "image" ? { document: card.captionJson, corrupt: card.corrupt } : null),
    write: (gateway, id, expectedRevision, captionJson) =>
      gateway.updateImageCaption({ id, expectedRevision, captionJson }),
  },
  embed: {
    label: "Edit description",
    read: (card) => (card.kind === "embed" ? { document: card.descriptionJson, corrupt: card.corrupt } : null),
    write: (gateway, id, expectedRevision, descriptionJson) =>
      gateway.updateEmbedDescription({ id, expectedRevision, descriptionJson }),
  },
};

/**
 * One text edit session of a note, image caption or link description,
 * recorded after the fact (the draft already saved it). The command owns the
 * card's TEXT only: undo/redo read the card fresh, refuse with
 * `CommandConflictError` unless the text is still exactly what this command
 * left (or the document is corrupt), and write the other document with the
 * fresh revision. `execute` is only ever a redo.
 */
export class EditCardTextCommand implements WorkspaceCommand {
  id: string;
  label: string;

  constructor(
    id: string,
    readonly kind: TextCardKind,
    readonly cardId: string,
    readonly before: unknown,
    readonly after: unknown,
  ) {
    this.id = id;
    this.label = TEXT_FIELDS[kind].label;
  }

  execute(gateway: WorkspaceGateway): Promise<void> {
    return this.replace(gateway, "redo", this.before, this.after);
  }

  undo(gateway: WorkspaceGateway): Promise<void> {
    return this.replace(gateway, "undo", this.after, this.before);
  }

  private async replace(gateway: WorkspaceGateway, action: "undo" | "redo", from: unknown, to: unknown): Promise<void> {
    const field = TEXT_FIELDS[this.kind];
    const card = await gateway.readCard(this.cardId);
    const current = field.read(card);
    // Поверх corrupt-документа пишем только через явный Repair (P1.7), не через undo.
    if (!current || current.corrupt || !sameDocument(current.document, from)) {
      throw new CommandConflictError(this.label, action);
    }
    await field.write(gateway, this.cardId, card.revision, to);
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/**
 * One resize gesture, recorded after the fact (the gesture already saved).
 * The command owns the whole FRAME (a resize may move x/y too): undo/redo read
 * the card fresh, refuse with `CommandConflictError` unless its frame is still
 * where this command left it (0.01 px tolerance), and write the other frame
 * with the fresh revision. Text is never touched. `execute` is only ever a redo.
 */
export class ResizeCardCommand implements WorkspaceCommand {
  id: string;
  label = "Resize";

  constructor(
    id: string,
    readonly cardId: string,
    readonly before: Frame,
    readonly after: Frame,
  ) {
    this.id = id;
  }

  execute(gateway: WorkspaceGateway): Promise<void> {
    return this.resize(gateway, "redo", this.before, this.after);
  }

  undo(gateway: WorkspaceGateway): Promise<void> {
    return this.resize(gateway, "undo", this.after, this.before);
  }

  private async resize(gateway: WorkspaceGateway, action: "undo" | "redo", from: Frame, to: Frame): Promise<void> {
    const card = await gateway.readCard(this.cardId);
    if (!sameFrame(card.frame, from)) throw new CommandConflictError(this.label, action);
    await gateway.moveCard({ id: this.cardId, expectedRevision: card.revision, frame: to });
  }

  mergeWith(): WorkspaceCommand<unknown> | null {
    return null;
  }
}

/** Position and size equal within the float round-trip tolerance. */
export function sameFrame(a: Frame, b: Frame): boolean {
  return (
    samePosition(a, b) &&
    Math.abs(a.width - b.width) < POSITION_EPSILON &&
    Math.abs(a.height - b.height) < POSITION_EPSILON
  );
}

/**
 * Structural equality of two documents (ProseMirror JSON). Object key order is
 * ignored: the backend's serde_json hands documents back with sorted keys.
 */
export function sameDocument(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameDocument(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bRecord = b as Record<string, unknown>;
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key) && sameDocument((a as Record<string, unknown>)[key], bRecord[key]))
  );
}
