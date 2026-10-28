import { useCallback, useRef, useState, type Dispatch } from "react";
import { errorMessage } from "../services/error-message";
import { useLatestRef } from "./use-latest-ref";
import type { IdGenerator } from "../services/id-generator";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import {
  CreateConnectorCommand,
  RemoveConnectorCommand,
  UpdateConnectorCommand,
  type ConnectorPatch,
} from "../commands/connector-commands";
import { NOTE_COLOR_OPTIONS } from "../cards/note/note-color";
import type { ContextMenuAction } from "../components/context-menu/ContextMenu";
import type { BoardSummary, ConnectorDto } from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";

/** Подписи цветов связи и группы в меню (id пресетов — те же, что у заметок). */
export const CONNECTOR_COLOR_LABELS: Record<string, string> = {
  default: "Default",
  yellow: "Yellow",
  pink: "Pink",
  lavender: "Lavender",
  blue: "Blue",
  green: "Green",
  gray: "Gray",
};

export interface ConnectorActionsDeps {
  board: BoardSummary | null;
  connectors: ConnectorDto[];
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<BoardViewAction>;
  /** Применяет каждое локальное изменение связей к store со штампом для слияния при перезагрузке. */
  cardWrites: CardWrites;
}

export interface ConnectorActionsController {
  connectorMenu: { connectorId: string; x: number; y: number } | null;
  closeConnectorMenu: () => void;
  /** Пункты открытого меню связи (пусто, когда меню закрыто). */
  connectorMenuActions: ContextMenuAction[];
  handleConnectorCreate: (e: { fromCardId: string; toCardId: string }) => void;
  handleConnectorSelectionChanged: (e: { ids: string[] }) => void;
  handleConnectorContextMenu: (connectorId: string, x: number, y: number) => void;
  /**
   * Delete/Backspace: удаляет выделенные связи, затем отправляет в корзину
   * выделенные карточки (`trashCards`). Связи, касающиеся карточек `cardIds`,
   * пропускаются — их и так снимет каскад корзины.
   */
  handleDeleteKey: (cardIds: string[], trashCards: () => Promise<void>) => Promise<void>;
}

/**
 * Действия со связями (стрелками): создание протягиванием ручки, выделение,
 * о котором сообщает холст, Delete по выделенным связям и контекстное меню
 * связи (цвет, стрелки, разворот, удаление). Каждое изменение идёт через
 * диспетчер команд, поэтому отменяемо.
 */
export function useConnectorActions(deps: ConnectorActionsDeps): ConnectorActionsController {
  const { board, connectors, dispatcher, idGenerator, dispatch, cardWrites } = deps;
  const [connectorMenu, setConnectorMenu] = useState<{ connectorId: string; x: number; y: number } | null>(null);
  // Ref, не state: Delete, нажатый сразу после клика по связи, приходит в
  // обработчик клавиш, который ещё не пересоздан с новым выделением.
  const selectedIdsRef = useRef<string[]>([]);
  const connectorsRef = useLatestRef(connectors);

  const fail = useCallback((e: unknown) => dispatch({ type: "failed", message: errorMessage(e) }), [dispatch]);

  const handleConnectorCreate = useCallback(
    ({ fromCardId, toCardId }: { fromCardId: string; toCardId: string }) => {
      if (!board) return;
      const input = { id: idGenerator.nextId(), boardId: board.id, fromCardId, toCardId };
      dispatcher
        .execute(new CreateConnectorCommand(idGenerator.nextId(), input))
        .then((connector) => cardWrites.apply({ type: "connectorCreated", connector }))
        .catch(fail);
    },
    [board, idGenerator, dispatcher, cardWrites, fail],
  );

  const handleConnectorSelectionChanged = useCallback(({ ids }: { ids: string[] }) => {
    selectedIdsRef.current = ids;
  }, []);

  const handleConnectorContextMenu = useCallback((connectorId: string, x: number, y: number) => {
    setConnectorMenu({ connectorId, x, y });
  }, []);

  const closeConnectorMenu = useCallback(() => setConnectorMenu(null), []);

  // Связи, чьё удаление уже ушло в бэкенд: повторное нажатие Delete (или
  // автоповтор) до ответа не отправляет их второй раз.
  const removingRef = useRef(new Set<string>());
  const remove = useCallback(
    async (ids: string[]) => {
      const pending = removingRef.current;
      const doomed = connectorsRef.current.filter((c) => ids.includes(c.id) && !pending.has(c.id));
      if (doomed.length === 0) return;
      doomed.forEach((c) => pending.add(c.id));
      try {
        await dispatcher.execute(new RemoveConnectorCommand(idGenerator.nextId(), doomed));
        cardWrites.apply({ type: "connectorsRemoved", ids: doomed.map((c) => c.id) });
      } catch (e) {
        fail(e);
      } finally {
        doomed.forEach((c) => pending.delete(c.id));
      }
    },
    [connectorsRef, dispatcher, idGenerator, cardWrites, fail],
  );

  // Строго по очереди, не параллельно: так порядок в истории undo определён —
  // первым отменяется удаление в корзину, затем удаление связей.
  // Пока одно удаление идёт, следующие вызовы (автоповтор клавиши) отбрасываются,
  // а не встают в очередь: второй вызов из устаревшего замыкания поменял бы
  // порядок в истории или повторно отправил бы те же карточки в корзину.
  const deleteInFlightRef = useRef<Promise<void> | null>(null);
  const handleDeleteKey = useCallback(
    (cardIds: string[], trashCards: () => Promise<void>) => {
      if (deleteInFlightRef.current) return deleteInFlightRef.current;
      const run = async () => {
        const trashing = new Set(cardIds);
        const selected = new Set(selectedIdsRef.current);
        const ids = connectorsRef.current
          .filter((c) => selected.has(c.id) && !trashing.has(c.fromCardId) && !trashing.has(c.toCardId))
          .map((c) => c.id);
        await remove(ids);
        await trashCards();
      };
      const inFlight = run().finally(() => {
        deleteInFlightRef.current = null;
      });
      deleteInFlightRef.current = inFlight;
      return inFlight;
    },
    [connectorsRef, remove],
  );

  const update = useCallback(
    (connector: ConnectorDto, after: ConnectorPatch) => {
      const keys = Object.keys(after) as (keyof ConnectorPatch)[];
      if (keys.every((key) => connector[key] === after[key])) return;
      const before = Object.fromEntries(keys.map((key) => [key, connector[key]])) as ConnectorPatch;
      dispatcher
        .execute(new UpdateConnectorCommand(idGenerator.nextId(), connector.id, connector.revision, before, after))
        .then((updated) => cardWrites.apply({ type: "connectorUpdated", connector: updated }))
        .catch(fail);
    },
    [dispatcher, idGenerator, cardWrites, fail],
  );

  const menuConnector = connectorMenu ? connectors.find((c) => c.id === connectorMenu.connectorId) : undefined;
  const connectorMenuActions: ContextMenuAction[] = menuConnector
    ? [
        ...NOTE_COLOR_OPTIONS.map((option) => ({
          id: `color-${option.id}`,
          label: CONNECTOR_COLOR_LABELS[option.id],
          onSelect: () => update(menuConnector, { colorToken: option.id }),
        })),
        { id: "arrow-end", label: "Arrow at end", onSelect: () => update(menuConnector, { arrowEnds: "end" }) },
        { id: "arrow-both", label: "Arrows both ends", onSelect: () => update(menuConnector, { arrowEnds: "both" }) },
        { id: "arrow-none", label: "No arrows", onSelect: () => update(menuConnector, { arrowEnds: "none" }) },
        {
          id: "reverse",
          label: "Reverse direction",
          onSelect: () =>
            update(menuConnector, { fromCardId: menuConnector.toCardId, toCardId: menuConnector.fromCardId }),
        },
        { id: "delete-connector", label: "Delete connector", onSelect: () => void remove([menuConnector.id]) },
      ]
    : [];

  return {
    connectorMenu,
    closeConnectorMenu,
    connectorMenuActions,
    handleConnectorCreate,
    handleConnectorSelectionChanged,
    handleConnectorContextMenu,
    handleDeleteKey,
  };
}
