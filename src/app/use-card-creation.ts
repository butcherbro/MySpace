import { useCallback, type Dispatch, type RefObject } from "react";
import { plainTextToDocument } from "../editor/document-codec";
import { CreateNoteCommand } from "../commands/card-commands";
import { CreateChildBoardCommand } from "../commands/board-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import { pickFolder, pickImageFile } from "../services/asset-picker";
import { computeInitialImageFrameSize, loadNaturalImageSize } from "../cards/image/image-card-geometry";
import { assetUrl } from "../services/asset-url";
import { buildCreateImageCardInput } from "./import-image-card";
import type {
  AssetDto,
  BoardPortalDto,
  BoardSummary,
  CardDto,
  FileCardDto,
  FilesystemAliasDto,
  ImageCardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";

/**
 * Card creation: note/link/child board/image/file card/folder shortcut, plus
 * opening and revealing a file card. Shared by the tool rail, the pane context
 * menu, native Finder drop, and paste (the last two call these handlers
 * through their own hooks).
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 8).
 */

export interface CardCreationDeps {
  board: BoardSummary | null;
  boardRef: RefObject<BoardSummary | null>;
  notes: NoteCardDto[];
  cards: CardDto[];
  cardsRef: RefObject<CardDto[]>;
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  gateway: WorkspaceGateway;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<CurrentBoardAction>;
}

export interface CardCreationController {
  handleCreateNote: (
    position?: { x: number; y: number },
    options?: { startEditing?: boolean; content?: { documentJson: unknown; plainText: string } },
  ) => Promise<void>;
  handleCreateLink: (position?: { x: number; y: number }) => void;
  handleCreateChildBoard: (position?: { x: number; y: number }) => Promise<void>;
  placeImageAsset: (asset: AssetDto, x: number, y: number, cardId: string, centered?: boolean) => Promise<void>;
  importImageCard: (
    sourcePath: string,
    fileName: string,
    mimeType: string,
    boardX: number,
    boardY: number,
  ) => Promise<void>;
  handleCreateImage: () => Promise<void>;
  createFolderShortcut: (sourcePath: string, boardX: number, boardY: number) => Promise<void>;
  createFileCard: (
    item: { path: string; fileName: string; mimeType: string },
    boardX: number,
    boardY: number,
  ) => Promise<void>;
  handleAddFolderShortcutViaDialog: (boardX: number, boardY: number) => Promise<void>;
  openFileCard: (cardId: string) => void;
  revealFileCard: (cardId: string) => void;
}

export function useCardCreation(deps: CardCreationDeps): CardCreationController {
  const { board, boardRef, notes, cards, cardsRef, screenToFlowRef, gateway, dispatcher, idGenerator, dispatch } =
    deps;

  const handleCreateNote = useCallback(
    async (
      position?: { x: number; y: number },
      options?: { startEditing?: boolean; content?: { documentJson: unknown; plainText: string } },
    ) => {
      if (!board) return;
      const id = idGenerator.nextId();
      // An explicit position (double-click on the empty pane, paste) places the
      // note exactly there; the rail/button path falls back to a cascading default.
      const x = position ? position.x : 40;
      const y = position ? position.y : 40 + notes.length * 24;
      const documentJson = options?.content?.documentJson ?? plainTextToDocument("");
      const plainText = options?.content?.plainText ?? "";
      const card: NoteCardDto = {
        kind: "note",
        id,
        boardId: board.id,
        frame: { x, y, width: 240, height: 120 },
        zIndex: notes.length,
        revision: 1,
        documentJson,
        plainText,
        colorToken: "default",
      };
      try {
        await dispatcher.execute(
          new CreateNoteCommand(id, {
            id,
            boardId: board.id,
            frame: card.frame,
            zIndex: card.zIndex,
            documentJson: card.documentJson,
          }),
        );
        dispatch({ type: "cardAdded", card });
        if (options?.startEditing) {
          dispatch({ type: "editingStarted", id });
        }
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [board, dispatcher, idGenerator, notes.length, dispatch],
  );

  const handleCreateLink = useCallback(
    (position?: { x: number; y: number }) => {
      void handleCreateNote(position, { startEditing: true });
    },
    [handleCreateNote],
  );

  const handleCreateChildBoard = useCallback(
    async (position?: { x: number; y: number }) => {
      if (!board) return;
      const boardId = idGenerator.nextId();
      const portalCardId = idGenerator.nextId();
      let frame;
      if (position) {
        frame = { x: position.x, y: position.y, width: 120, height: 112 };
      } else {
        // Place the new board near the visible viewport center so it never lands
        // far down the board outside the current view.
        const flow = screenToFlowRef.current;
        const center = flow
          ? flow(window.innerWidth * 0.5, window.innerHeight * 0.5)
          : { x: 200, y: 120 };
        const offset = (cards.length % 5) * 24;
        frame = {
          x: center.x - 60 + offset,
          y: center.y - 56 + offset,
          width: 120,
          height: 112,
        };
      }
      const portal: BoardPortalDto = {
        kind: "board_portal",
        id: portalCardId,
        boardId: board.id,
        frame,
        zIndex: 0,
        revision: 1,
        target: {
          id: boardId,
          boardRevision: 1,
          title: "New Board",
          colorToken: "terracotta",
          symbol: null,
          childBoardCount: 0,
          childCardCount: 0,
          coverAsset: null,
        },
      };
      try {
        await dispatcher.execute(
          new CreateChildBoardCommand(idGenerator.nextId(), {
            parentBoardId: board.id,
            boardId,
            portalCardId,
            frame: portal.frame,
            title: "New Board",
          }),
        );
        dispatch({ type: "cardAdded", card: portal });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [board, dispatcher, idGenerator, cards.length, dispatch, screenToFlowRef],
  );

  // Creates an image card for an already-imported asset at board coordinates.
  const placeImageAsset = useCallback(
    async (asset: AssetDto, x: number, y: number, cardId: string, centered = false) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      {
        // Backend не читает natural width/height картинки при импорте
        // (assets.width/height в БД всегда NULL), поэтому пропорции для
        // стартового frame берём в браузере — иначе карточка получает
        // фиксированный 320x240 и обрезает картинку под рамку (todo.md №3).
        const natural = await loadNaturalImageSize(assetUrl(asset.filePath));
        const { width, height } = computeInitialImageFrameSize(natural?.width, natural?.height);
        const card: ImageCardDto = {
          kind: "image",
          id: cardId,
          boardId: currentBoard.id,
          frame: centered
            ? { x: Math.max(0, x - width / 2), y: Math.max(0, y - height / 2), width, height }
            : { x, y, width, height },
          zIndex: cardsRef.current.length,
          revision: 1,
          asset,
          captionJson: plainTextToDocument(""),
          captionPlainText: "",
        };
        await gateway.createImageCard(
          buildCreateImageCardInput({
            cardId,
            boardId: currentBoard.id,
            frame: card.frame,
            zIndex: card.zIndex,
            asset,
            captionJson: card.captionJson,
          }),
        );
        dispatch({ type: "cardAdded", card });
      }
    },
    [gateway, boardRef, cardsRef, dispatch],
  );

  // Imports an image and creates a card at the given board coordinates. Shared
  // by the file picker (button) and native drag-drop.
  const importImageCard = useCallback(
    async (sourcePath: string, fileName: string, mimeType: string, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      // Guard against NaN/Infinity (e.g. screen->board conversion before the
      // canvas instance is ready) — such values serialize to null/error over IPC.
      const x = Number.isFinite(boardX) ? boardX : 80;
      const y = Number.isFinite(boardY) ? boardY : 80;
      const assetId = idGenerator.nextId();
      const cardId = idGenerator.nextId();
      try {
        const asset = await gateway.importAsset({
          id: assetId,
          sourcePath,
          fileName,
          mimeType,
        });
        await placeImageAsset(asset, x, y, cardId);
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator, placeImageAsset, boardRef, dispatch],
  );

  const handleCreateImage = useCallback(async () => {
    const picked = await pickImageFile();
    if (!picked) return;
    await importImageCard(picked.path, picked.fileName, picked.mimeType, 80, 80 + cardsRef.current.length * 24);
  }, [importImageCard, cardsRef]);

  const createFolderShortcut = useCallback(
    async (sourcePath: string, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const frame = {
        x: Number.isFinite(boardX) ? boardX : 80,
        y: Number.isFinite(boardY) ? boardY : 80,
        width: 360,
        height: 300,
      };
      try {
        const card: FilesystemAliasDto = await gateway.createFolderAlias({
          id: idGenerator.nextId(),
          boardId: currentBoard.id,
          frame,
          zIndex: cardsRef.current.length,
          sourcePath,
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator, boardRef, cardsRef, dispatch],
  );

  const createFileCard = useCallback(
    async (item: { path: string; fileName: string; mimeType: string }, boardX: number, boardY: number) => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return;
      const frame = {
        x: Number.isFinite(boardX) ? boardX : 80,
        y: Number.isFinite(boardY) ? boardY : 80,
        width: 320,
        height: 240,
      };
      try {
        const card: FileCardDto = await gateway.createFileCard({
          id: idGenerator.nextId(),
          boardId: currentBoard.id,
          frame,
          zIndex: cardsRef.current.length,
          sourcePath: item.path,
          mimeType: item.mimeType,
          fileName: item.fileName,
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator, boardRef, cardsRef, dispatch],
  );

  // "Add Folder Shortcut…" on the pane context menu (todo.md №23): the native
  // folder picker, then the same creation call as a Finder drop/pasted path.
  const handleAddFolderShortcutViaDialog = useCallback(
    async (boardX: number, boardY: number) => {
      const picked = await pickFolder();
      if (!picked) return;
      await createFolderShortcut(picked, boardX, boardY);
    },
    [createFolderShortcut],
  );

  const openFileCard = useCallback(
    (cardId: string) => {
      void gateway.openFileCard(cardId).catch((e) => dispatch({ type: "failed", message: errorMessage(e) }));
    },
    [gateway, dispatch],
  );

  const revealFileCard = useCallback(
    (cardId: string) => {
      void gateway.revealFileCard(cardId).catch((e) => dispatch({ type: "failed", message: errorMessage(e) }));
    },
    [gateway, dispatch],
  );

  return {
    handleCreateNote,
    handleCreateLink,
    handleCreateChildBoard,
    placeImageAsset,
    importImageCard,
    handleCreateImage,
    createFolderShortcut,
    createFileCard,
    handleAddFolderShortcutViaDialog,
    openFileCard,
    revealFileCard,
  };
}
