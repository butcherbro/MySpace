// Команды над связями (стрелками между карточками).

import type {
  ConnectorDto,
  CreateConnectorInput,
  UpdateConnectorInput,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";

/** Поля связи, которые меняет update (в v1 подпись из UI не правится). */
export type ConnectorPatch = Pick<
  UpdateConnectorInput,
  "colorToken" | "arrowEnds" | "fromCardId" | "toCardId" | "label"
>;

/** Создаёт связь. `undo` удаляет её; redo создаёт снова с тем же id (бэкенд восстанавливает мягко удалённую). */
export class CreateConnectorCommand implements WorkspaceCommand<ConnectorDto> {
  id: string;
  label = "Connect cards";

  constructor(
    id: string,
    private input: CreateConnectorInput,
  ) {
    this.id = id;
  }

  execute(gateway: WorkspaceGateway): Promise<ConnectorDto> {
    return gateway.createConnector(this.input);
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    await gateway.removeConnector({ connectorId: this.input.id });
  }
}

/**
 * Удаляет одну или несколько связей одной записью истории. `undo` вызывает
 * create с тем же id: бэкенд восстанавливает мягко удалённую связь целиком
 * (с ревизией и подписью), поэтому цепочка undo/redo адресует те же связи и
 * ревизии в более ранних командах остаются верными.
 */
export class RemoveConnectorCommand implements WorkspaceCommand {
  id: string;
  label = "Delete connector";

  constructor(
    id: string,
    private connectors: ConnectorDto[],
  ) {
    this.id = id;
  }

  async execute(gateway: WorkspaceGateway): Promise<void> {
    for (const c of this.connectors) await gateway.removeConnector({ connectorId: c.id });
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    for (const c of this.connectors) {
      await gateway.createConnector({
        id: c.id,
        boardId: c.boardId,
        fromCardId: c.fromCardId,
        toCardId: c.toCardId,
        colorToken: c.colorToken,
        arrowEnds: c.arrowEnds,
      });
    }
  }
}

/**
 * Меняет цвет, концы со стрелками или направление связи. Каждый вызов несёт
 * ревизию из предыдущего ответа — фронт её не угадывает; если связь тем
 * временем изменили в другом месте, вызов падает с `stale_revision`, и
 * диспетчер выбрасывает запись.
 */
export class UpdateConnectorCommand implements WorkspaceCommand<ConnectorDto> {
  id: string;
  label = "Edit connector";
  private revision: number;

  constructor(
    id: string,
    private connectorId: string,
    expectedRevision: number,
    private before: ConnectorPatch,
    private after: ConnectorPatch,
  ) {
    this.id = id;
    this.revision = expectedRevision;
  }

  async execute(gateway: WorkspaceGateway): Promise<ConnectorDto> {
    const dto = await gateway.updateConnector({
      connectorId: this.connectorId,
      expectedRevision: this.revision,
      ...this.after,
    });
    this.revision = dto.revision;
    return dto;
  }

  async undo(gateway: WorkspaceGateway): Promise<void> {
    const dto = await gateway.updateConnector({
      connectorId: this.connectorId,
      expectedRevision: this.revision,
      ...this.before,
    });
    this.revision = dto.revision;
  }
}
