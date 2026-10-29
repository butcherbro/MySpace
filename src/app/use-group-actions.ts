import { useCallback, type Dispatch, type RefObject } from "react";
import { CreateGroupCommand, UpdateGroupCommand, type GroupPatch } from "../commands/group-commands";
import { TrashSelectionCommand } from "../commands/trash-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { NOTE_COLOR_OPTIONS } from "../cards/note/note-color";
import { GROUP_MAX_HEIGHT, GROUP_MAX_WIDTH } from "../cards/group/group-frame";
import type { ContextMenuAction } from "../components/context-menu/ContextMenu";
import type { MutationQueue } from "../persistence/entity-write-queue";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import type { BoardSummary, CardDto, Frame, GroupCardDto } from "../services/workspace-gateway";
import type { CardWrites } from "../state/card-writes";
import type { BoardViewAction } from "../state/current-board-store";
import { CONNECTOR_COLOR_LABELS } from "./use-connector-actions";

/** Отступ рамки новой группы от выделения с каждой стороны (ADR-0013). */
export const GROUP_PADDING = 24;
/** Дополнительное место сверху под плашку названия. */
export const GROUP_TITLE_SPACE = 36;

/**
 * Рамка новой группы вокруг `frames`: общий охватывающий прямоугольник плюс
 * `GROUP_PADDING` с каждой стороны и `GROUP_TITLE_SPACE` сверху. Левый и
 * верхний край не уходят за начало доски (холст не показывает отрицательных
 * координат) — тогда отступ с той стороны меньше, но карточки всё равно внутри.
 */
export function groupFrameAround(frames: readonly Frame[]): Frame | null {
  if (frames.length === 0) return null;
  const minX = Math.min(...frames.map((f) => f.x));
  const minY = Math.min(...frames.map((f) => f.y));
  const maxX = Math.max(...frames.map((f) => f.x + f.width));
  const maxY = Math.max(...frames.map((f) => f.y + f.height));
  const x = Math.max(0, minX - GROUP_PADDING);
  const y = Math.max(0, minY - GROUP_PADDING - GROUP_TITLE_SPACE);
  return { x, y, width: maxX + GROUP_PADDING - x, height: maxY + GROUP_PADDING - y };
}

/**
 * Члены новой группы из выделения `selection`: каждая выделенная карточка, кроме
 * тех, чья группа (или любая группа выше по цепочке) сама выделена, — выделенная
 * группа сохраняет своих членов и входит в новую целиком.
 */
export function groupSelectionMemberIds(selection: readonly string[], cards: readonly CardDto[]): string[] {
  const selected = new Set(selection);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const hasSelectedAncestor = (card: CardDto): boolean => {
    // visited: хранимая цепочка может быть зациклена (синк), обход обязан кончиться.
    const visited = new Set<string>([card.id]);
    let groupId = card.groupId;
    while (groupId !== null && !visited.has(groupId)) {
      if (selected.has(groupId)) return true;
      visited.add(groupId);
      groupId = byId.get(groupId)?.groupId ?? null;
    }
    return false;
  };
  return cards.filter((c) => selected.has(c.id) && !hasSelectedAncestor(c)).map((c) => c.id);
}

/**
 * Группа, в которую вкладывается новая: общая группа всех членов, если она у
 * них одна и та же, иначе `null`. Не по геометрии: рамка, лишь лежащая поверх
 * карточек, ими не владеет, и группировка не должна отдавать их ей.
 */
export function commonGroupId(memberIds: readonly string[], cards: readonly CardDto[]): string | null {
  const groups = new Set(memberIds.map((id) => cards.find((c) => c.id === id)?.groupId ?? null));
  const [only] = groups;
  return groups.size === 1 ? (only ?? null) : null;
}

/** Баннер, когда рамка вокруг выделения больше допустимой. */
export const GROUP_TOO_LARGE_MESSAGE =
  `The group would be too large (at most ${GROUP_MAX_WIDTH} × ${GROUP_MAX_HEIGHT} px). Select fewer or closer cards.`;

export interface GroupActionsDeps {
  board: BoardSummary | null;
  cards: CardDto[];
  selection: string[];
  cardsRef: RefObject<CardDto[]>;
  queueRef: RefObject<MutationQueue>;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<BoardViewAction>;
  cardWrites: CardWrites;
  refreshTrash: () => Promise<void>;
}

export interface GroupActionsController {
  /** Обвести выделенные карточки новой группой (меню «Group», Cmd/Ctrl+G). */
  groupSelection: () => Promise<void>;
  /** Убрать рамку: только сама группа уходит в корзину, карточки не трогаются. */
  ungroup: (groupIds: string[]) => Promise<void>;
  /** «Разгруппировать» все выделенные группы (Cmd/Ctrl+Shift+G). */
  ungroupSelection: () => Promise<void>;
  /** Войти в переименование (плашка становится полем ввода). */
  startRename: (groupId: string) => void;
  rename: (groupId: string, title: string) => void;
  recolor: (groupId: string, colorToken: string) => void;
  /** Пункты контекстного меню группы, кроме «Delete» (его даёт общее меню карточки). */
  groupMenuActions: (group: GroupCardDto) => ContextMenuAction[];
}

/**
 * Действия с группами (ADR-0013): создание вокруг выделения, переименование,
 * цвет и «Разгруппировать». Каждое изменение идёт через диспетчер команд и
 * отменяемо; локальное состояние обновляется из ответов бэкенда.
 */
export function useGroupActions(deps: GroupActionsDeps): GroupActionsController {
  const { board, cards, selection, cardsRef, queueRef, dispatcher, idGenerator, dispatch, cardWrites, refreshTrash } =
    deps;

  const fail = useCallback((e: unknown) => dispatch({ type: "failed", message: errorMessage(e) }), [dispatch]);

  // Через общую очередь мутаций: создание поднимает ревизии членов, и запись,
  // уже стоящая в очереди с прежней ревизией, не должна упереться в stale_revision.
  const groupSelection = useCallback(
    () =>
      queueRef.current
        .run(async () => {
          if (!board) return;
          const current = cardsRef.current;
          const selected = new Set(selection);
          const frame = groupFrameAround(current.filter((c) => selected.has(c.id)).map((c) => c.frame));
          if (!frame) return;
          // Бэкенд отверг бы такую рамку как constraint_violation с техническим
          // текстом; говорим пользователю понятнее и не зовём шлюз.
          if (frame.width > GROUP_MAX_WIDTH || frame.height > GROUP_MAX_HEIGHT) {
            dispatch({ type: "failed", message: GROUP_TOO_LARGE_MESSAGE });
            return;
          }
          const memberIds = groupSelectionMemberIds(selection, current);
          const input = {
            id: idGenerator.nextId(),
            boardId: board.id,
            frame,
            zIndex: 0,
            title: "",
            colorToken: "default",
            memberIds,
            groupId: commonGroupId(memberIds, current),
          };
          const membersBefore = memberIds.map((id) => ({
            id,
            groupId: current.find((c) => c.id === id)?.groupId ?? null,
          }));
          const receipt = await dispatcher.execute(
            new CreateGroupCommand(idGenerator.nextId(), input, membersBefore),
          );
          cardWrites.apply({ type: "cardAdded", card: receipt.group });
          for (const member of receipt.members) {
            cardWrites.apply({ type: "cardGrouped", id: member.id, revision: member.revision, groupId: receipt.group.id });
          }
        })
        .catch(fail),
    [board, selection, queueRef, cardsRef, dispatcher, idGenerator, cardWrites, dispatch, fail],
  );

  const ungroup = useCallback(
    async (groupIds: string[]) => {
      const ids = groupIds.filter((id) => cards.some((c) => c.id === id && c.kind === "group"));
      if (ids.length === 0) return;
      try {
        await dispatcher.execute(
          new TrashSelectionCommand(
            idGenerator.nextId(),
            ids.map((id) => ({ id, kind: "group" as const })),
          ),
        );
        cardWrites.apply({ type: "cardsRemoved", ids });
        void refreshTrash();
      } catch (e) {
        fail(e);
      }
    },
    [cards, dispatcher, idGenerator, cardWrites, refreshTrash, fail],
  );

  const ungroupSelection = useCallback(() => ungroup(selection), [ungroup, selection]);

  const startRename = useCallback((groupId: string) => dispatch({ type: "editingStarted", id: groupId }), [dispatch]);

  // Через общую очередь мутаций: ревизия читается в момент записи, поэтому
  // переименование сразу после перетаскивания рамки не упирается в stale_revision.
  const update = useCallback(
    (groupId: string, after: GroupPatch) => {
      void queueRef.current
        .run(async () => {
          const held = cardsRef.current.find((c): c is GroupCardDto => c.id === groupId && c.kind === "group");
          if (!held) return;
          const keys = Object.keys(after) as (keyof GroupPatch)[];
          if (keys.every((key) => held[key] === after[key])) return;
          const before = Object.fromEntries(keys.map((key) => [key, held[key]])) as GroupPatch;
          const receipt = await dispatcher.execute(
            new UpdateGroupCommand(idGenerator.nextId(), groupId, held.revision, before, after),
          );
          const current = cardsRef.current.find((c): c is GroupCardDto => c.id === groupId && c.kind === "group");
          if (current) cardWrites.apply({ type: "cardStored", id: groupId, card: { ...current, ...after, revision: receipt.revision } });
        })
        .catch(fail);
    },
    [queueRef, cardsRef, dispatcher, idGenerator, cardWrites, fail],
  );

  const rename = useCallback((groupId: string, title: string) => update(groupId, { title }), [update]);
  const recolor = useCallback((groupId: string, colorToken: string) => update(groupId, { colorToken }), [update]);

  const groupMenuActions = useCallback(
    (group: GroupCardDto): ContextMenuAction[] => [
      { id: "rename-group", label: "Rename", onSelect: () => startRename(group.id), section: "rename" },
      ...NOTE_COLOR_OPTIONS.map((option) => ({
        id: `group-color-${option.id}`,
        label: CONNECTOR_COLOR_LABELS[option.id],
        onSelect: () => recolor(group.id, option.id),
        section: "color",
      })),
      {
        id: "ungroup",
        label: "Ungroup",
        // Как ⇧⌘G: разгруппировать всё выделение. Правый клик по группе вне
        // выделения сам выделяет её, так что одна группа тоже попадает сюда.
        onSelect: () => void ungroupSelection(),
        section: "arrange",
        shortcut: "Mod+Shift+G",
      },
    ],
    [startRename, recolor, ungroupSelection],
  );

  return { groupSelection, ungroup, ungroupSelection, startRename, rename, recolor, groupMenuActions };
}
