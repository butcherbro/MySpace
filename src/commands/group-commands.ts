// Команды над группами (ADR-0013). Перемещение, изменение размера и
// «Разгруппировать» идут существующими командами карточек
// (`MoveCardsCommand`, `ResizeCardCommand`, `TrashSelectionCommand`).

import type {
  CardReceipt,
  CreateGroupInput,
  GroupCreatedReceipt,
  UpdateGroupInput,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import { CommandConflictError, type WorkspaceCommand } from "./workspace-command";

/** Поля группы, которые меняет update. */
export type GroupPatch = Pick<UpdateGroupInput, "title" | "colorToken">;

/** Член новой группы и группа, в которой он состоял до создания. */
export interface GroupMemberBefore {
  id: string;
  groupId: string | null;
}

/**
 * Создаёт группу вместе с членами (`memberIds`). `undo` отправляет рамку в
 * корзину — членство членов «засыпает»; тех, кто до создания состоял в другой
 * группе, undo возвращает туда (иначе они выпали бы и из неё). Redo
 * восстанавливает ту же партию и снова переводит их в новую группу.
 */
export class CreateGroupCommand implements WorkspaceCommand<GroupCreatedReceipt> {
  id: string;
  label = "Group";
  private trashBatchId: string | null = null;
  private created: GroupCreatedReceipt | null = null;

  constructor(
    id: string,
    private input: CreateGroupInput,
    private membersBefore: readonly GroupMemberBefore[] = [],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<GroupCreatedReceipt> {
    if (this.trashBatchId) {
      await gateway.restoreTrashBatch(this.trashBatchId);
      this.trashBatchId = null;
      if (!this.created) {
        throw new Error("create group redo ran before its first execute");
      }
      await this.reassign(gateway, () => this.input.id);
      return this.created;
    }
    this.created = await gateway.createGroup(this.input);
    return this.created;
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    if (!this.created) {
      throw new Error("create group cannot be undone before it ran");
    }
    this.trashBatchId = await gateway.trashNote(this.input.id);
    await this.reassign(gateway, (member) => member.groupId);
  }

  /**
   * Одна запись MoveCards без сдвига: членам, у которых до создания была своя
   * группа, ставит `groupId` из `target`. Ревизии и рамки читаются заново
   * прямо перед записью (как `UpdateGroupCommand`).
   */
  private async reassign(
    gateway: WorkspaceGateway,
    target: (member: GroupMemberBefore) => string | null,
  ): Promise<void> {
    const members = this.membersBefore.filter((m) => m.groupId !== null);
    if (members.length === 0) return;
    const current = await Promise.all(members.map((m) => gateway.readCard(m.id)));
    await gateway.moveCards({
      cards: members.map((m, i) => ({
        id: m.id,
        expectedRevision: current[i].revision,
        frame: current[i].frame,
        group: { groupId: target(m) },
      })),
    });
  }
}

/**
 * Меняет название и/или цвет группы. Первый вызов пишет с ревизией, которую
 * вызывающий прочитал в очереди мутаций. Undo и redo читают карточку заново
 * прямо перед записью (как `ResizeCardCommand`): перемещение или изменение
 * размера между ними поднимает ревизию. Если название/цвет уже не те, что
 * оставила эта команда, запись отказывается с `CommandConflictError`.
 */
export class UpdateGroupCommand implements WorkspaceCommand<CardReceipt> {
  id: string;
  label = "Edit group";
  private executed = false;

  constructor(
    id: string,
    private cardId: string,
    private expectedRevision: number,
    private before: GroupPatch,
    private after: GroupPatch,
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<CardReceipt> {
    if (!this.executed) {
      const receipt = await gateway.updateGroup({
        cardId: this.cardId,
        expectedRevision: this.expectedRevision,
        ...this.after,
      });
      this.executed = true;
      return receipt;
    }
    return this.replace(gateway, "redo", this.before, this.after);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await this.replace(gateway, "undo", this.after, this.before);
  }

  private async replace(
    gateway: WorkspaceGateway,
    action: "undo" | "redo",
    from: GroupPatch,
    to: GroupPatch,
  ): Promise<CardReceipt> {
    const card = await gateway.readCard(this.cardId);
    if (card.kind !== "group") throw new CommandConflictError(this.label, action);
    const keys = Object.keys(from) as (keyof GroupPatch)[];
    if (keys.some((key) => card[key] !== from[key])) throw new CommandConflictError(this.label, action);
    return gateway.updateGroup({ cardId: this.cardId, expectedRevision: card.revision, ...to });
  }
}
