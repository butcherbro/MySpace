import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import type { BoardNavigation } from "../navigation/use-board-navigation";
import type { BoardSummary, WorkspaceGateway } from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import { shouldReload, type ChangeSample } from "../state/external-change-detector";
import { useSyncAppliedReload } from "../sync/use-sync-state";

/**
 * Keeping the open board current: reload after undo/redo, the 3 s poll for
 * writes by another process (agent, second instance) and the reload after a
 * LAN sync replay. Every reload goes through `navigateTo` on the same board,
 * whose same-board merge keeps pan, editing and selection.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 11).
 */

export interface BoardRefreshDeps {
  gateway: WorkspaceGateway;
  board: BoardSummary | null;
  dispatcher: CommandDispatcher;
  dispatch: Dispatch<BoardViewAction>;
  navigateTo: BoardNavigation["navigateTo"];
  refreshTrash: () => Promise<void>;
  loadQuickBoards: () => void;
  reloadBoardRef: RefObject<(() => Promise<void>) | null>;
}

export function useBoardRefresh(deps: BoardRefreshDeps) {
  const { gateway, board, dispatcher, dispatch, navigateTo, refreshTrash, loadQuickBoards, reloadBoardRef } = deps;

  // Reload the current board (no history push). Used to reconcile UI with the
  // database after undo/redo.
  const reloadCurrentBoard = useCallback(async () => {
    if (board) await navigateTo(board.id, { reload: true });
  }, [board, navigateTo]);

  useEffect(() => {
    reloadBoardRef.current = reloadCurrentBoard;
  }, [reloadCurrentBoard, reloadBoardRef]);

  const handleWorkspaceUndo = useCallback(async () => {
    try {
      if (await dispatcher.undo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard, dispatch]);

  const handleWorkspaceRedo = useCallback(async () => {
    try {
      if (await dispatcher.redo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard, dispatch]);

  // Detect external (agent / second instance) writes (P1.6). Every 3 s poll the
  // open board's `get_board_change_seq`: reload the board only when another
  // process committed (dataVersion) AND the commit touched this board
  // (changeSeq); refresh the trash on any external commit. The decision lives
  // in `shouldReload`; a sample for a different board just re-primes it. The
  // same-board `snapshotLoaded` merge keeps pan, editing and selection.
  const changeSampleRef = useRef<ChangeSample | null>(null);
  const openBoardId = board?.id ?? null;
  useEffect(() => {
    if (openBoardId === null) return;
    let cancelled = false;
    const poll = () => {
      gateway.getBoardChangeSeq(openBoardId).then(
        (v) => {
          if (cancelled) return;
          const next: ChangeSample = { boardId: openBoardId, ...v };
          const decision = shouldReload(changeSampleRef.current, next);
          changeSampleRef.current = next;
          if (decision.reloadBoard) void navigateTo(openBoardId, { reload: true });
          if (decision.refreshTrash) void refreshTrash();
        },
        () => {
          // The board may have been removed externally; the next navigation
          // re-primes. Polling never surfaces an error.
        },
      );
    };
    // Prime (or re-prime after a board switch) immediately.
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gateway, openBoardId, navigateTo, refreshTrash]);

  // LAN sync (ADR-0011 S3): a replay commits on the app's own writer, so the
  // poll above never sees it; `sync-applied` names the boards it changed and
  // the open one reloads through the same same-board merge.
  useSyncAppliedReload(
    gateway,
    openBoardId,
    (boardId) => void navigateTo(boardId, { reload: true }),
    () => {
      // Quick boards and the trash badge are not part of the board load.
      void refreshTrash();
      loadQuickBoards();
    },
  );

  return { reloadCurrentBoard, handleWorkspaceUndo, handleWorkspaceRedo };
}
