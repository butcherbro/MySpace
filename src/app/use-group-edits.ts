import { useCallback, type Dispatch, type RefObject } from "react";
import { ResizeCardCommand, sameFrame } from "../commands/card-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { MutationQueue } from "../persistence/entity-write-queue";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import type { CardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CardWrites } from "../state/card-writes";
import type { BoardViewAction } from "../state/current-board-store";

export interface GroupEditsDeps {
  gateway: WorkspaceGateway;
  dispatch: Dispatch<BoardViewAction>;
  cardWrites: CardWrites;
  queueRef: RefObject<MutationQueue>;
  cardsRef: RefObject<CardDto[]>;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
}

export interface GroupEditsController {
  handleResizeGroup: (id: string, width: number, height: number) => void;
}

/**
 * Изменение размера группы (ADR-0013) — тем же путём, что и у остальных
 * карточек: запись рамки в общей очереди мутаций (ревизия читается из
 * `cardsRef` в момент записи, не в момент жеста) и `ResizeCardCommand` в
 * историю. Карточки внутри не двигаются никогда.
 */
export function useGroupEdits(deps: GroupEditsDeps): GroupEditsController {
  const { gateway, dispatch, cardWrites, queueRef, cardsRef, dispatcher, idGenerator } = deps;

  const handleResizeGroup = useCallback(
    (id: string, width: number, height: number) => {
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.id === id);
          if (!current) return;
          const frame = { ...current.frame, width, height };
          if (sameFrame(current.frame, frame)) return;
          const receipt = await gateway.moveCard({ id, expectedRevision: current.revision, frame });
          cardWrites.apply({ type: "cardMoved", id, revision: receipt.revision, frame });
          void dispatcher.record(new ResizeCardCommand(idGenerator.nextId(), id, current.frame, frame));
        })
        .catch((e) => dispatch({ type: "failed", message: errorMessage(e) }));
    },
    [gateway, dispatch, cardWrites, queueRef, cardsRef, dispatcher, idGenerator],
  );

  return { handleResizeGroup };
}
