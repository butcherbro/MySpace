import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { errorMessage } from "../services/error-message";
import type { QuickBoardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";

/**
 * Quick Boards rail: persisted, ordered references to Boards. Loads once at
 * startup and keeps the local list in sync with pin/remove/reorder actions.
 *
 * `handleQuickBoardOpen` stays in `App.tsx`, not here: it only calls
 * `navigateTo` from board navigation, and `navigateTo` is declared later in
 * `App` than this hook can be — `loadQuickBoards` has to exist before
 * `useTrashController`, which reloads Quick Boards after restore/empty.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 3).
 */

export interface QuickBoardsOptions {
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
}

export interface QuickBoardsController {
  quickBoards: QuickBoardDto[];
  setQuickBoards: Dispatch<SetStateAction<QuickBoardDto[]>>;
  loadQuickBoards: () => void;
  handleQuickBoardRemove: (boardId: string) => void;
  handleQuickBoardPin: (boardId: string) => void;
  handleQuickBoardsReorder: (boardIds: string[]) => void;
}

export function useQuickBoards(options: QuickBoardsOptions): QuickBoardsController {
  const { gateway, dispatch } = options;

  const [quickBoards, setQuickBoards] = useState<QuickBoardDto[]>([]);

  // Load persisted Quick Board references once at startup.
  const loadQuickBoards = useCallback(() => {
    void gateway
      .listQuickBoards()
      .then(setQuickBoards)
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
    // dispatch стабилен (useReducer), но вне App линтер этого не видит — указываем явно.
  }, [gateway, dispatch]);

  useEffect(() => {
    loadQuickBoards();
  }, [loadQuickBoards]);

  // Quick Boards: remove deletes only the reference, and pin adds a reference
  // without moving/reparenting the Board. (Open lives in App, after `navigateTo`.)
  const handleQuickBoardRemove = useCallback(
    (boardId: string) => {
      void gateway
        .removeQuickBoard(boardId)
        .then(loadQuickBoards)
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, loadQuickBoards, dispatch],
  );

  const handleQuickBoardPin = useCallback(
    (boardId: string) => {
      void gateway
        .addQuickBoard({ boardId })
        .then(loadQuickBoards)
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, loadQuickBoards, dispatch],
  );

  const handleQuickBoardsReorder = useCallback(
    (boardIds: string[]) => {
      // Optimistically apply the new order, then persist transactionally.
      setQuickBoards((prev) => {
        const byId = new Map(prev.map((q) => [q.boardId, q]));
        const next: QuickBoardDto[] = [];
        for (const id of boardIds) {
          const q = byId.get(id);
          if (q) next.push({ ...q, sortOrder: next.length });
        }
        return next;
      });
      void gateway
        .reorderQuickBoards({ boardIds })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
          loadQuickBoards();
        });
    },
    [gateway, loadQuickBoards, dispatch],
  );

  return {
    quickBoards,
    setQuickBoards,
    loadQuickBoards,
    handleQuickBoardRemove,
    handleQuickBoardPin,
    handleQuickBoardsReorder,
  };
}
