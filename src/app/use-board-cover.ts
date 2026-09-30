import { useCallback, type Dispatch, type SetStateAction } from "react";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import { pickImageFile } from "../services/asset-picker";
import type { BoardPortalDto, CardDto, QuickBoardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";

/**
 * Board cover actions: set from clipboard, choose a file, or remove. Each
 * updates the local portal projection immediately (boardCoverChanged) so the tile
 * re-renders without a full board reload.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 2).
 */

export interface BoardCoverOptions {
  /** The card the context menu is open on; without it there is nothing to cover. */
  contextMenu: { cardId: string } | null;
  cards: CardDto[];
  gateway: WorkspaceGateway;
  idGenerator: IdGenerator;
  dispatch: Dispatch<CurrentBoardAction>;
  setQuickBoards: Dispatch<SetStateAction<QuickBoardDto[]>>;
}

export interface BoardCoverController {
  handleSetCoverFromClipboard: () => Promise<void>;
  handleChooseCover: () => Promise<void>;
  handleRemoveCover: () => Promise<void>;
}

export function useBoardCover(options: BoardCoverOptions): BoardCoverController {
  const { contextMenu, cards, gateway, idGenerator, dispatch, setQuickBoards } = options;

  const handleSetCoverFromClipboard = useCallback(async () => {
    if (!contextMenu) return;
    const portal = cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      const asset = await gateway.importClipboardImage();
      await gateway.setBoardCover({ boardId: portal.target.id, assetId: asset.id });
      dispatch({ type: "boardCoverChanged", boardId: portal.target.id, coverAsset: asset });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: asset }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
    // dispatch и setQuickBoards стабильны (useReducer/useState), но вне App
    // линтер этого не видит — указываем явно.
  }, [contextMenu, cards, gateway, dispatch, setQuickBoards]);

  const handleChooseCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    const picked = await pickImageFile();
    if (!picked) return;
    try {
      const asset = await gateway.importAsset({
        id: idGenerator.nextId(),
        sourcePath: picked.path,
        fileName: picked.fileName,
        mimeType: picked.mimeType,
      });
      await gateway.setBoardCover({ boardId: portal.target.id, assetId: asset.id });
      // Не cardReplaced с копией портала из замыкания: за секунды выбора файла
      // портал мог уйти на новую ревизию, и устаревшая копия была бы отброшена.
      dispatch({ type: "boardCoverChanged", boardId: portal.target.id, coverAsset: asset });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: asset }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, cards, gateway, idGenerator, dispatch, setQuickBoards]);

  const handleRemoveCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      await gateway.removeBoardCover(portal.target.id);
      dispatch({ type: "boardCoverChanged", boardId: portal.target.id, coverAsset: null });
      setQuickBoards((boards) =>
        boards.map((quickBoard) =>
          quickBoard.boardId === portal.target.id
            ? { ...quickBoard, coverAsset: null }
            : quickBoard,
        ),
      );
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, cards, gateway, dispatch, setQuickBoards]);

  return { handleSetCoverFromClipboard, handleChooseCover, handleRemoveCover };
}
