import { useCallback, type Dispatch, type RefObject } from "react";
import { documentToPlainText, plainTextToDocument } from "../editor/document-codec";
import { htmlToDocument } from "../editor/html-to-document";
import { PasteCardsCommand, type PasteCardSpec } from "../commands/paste-commands";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import { fileNameFromPath } from "../services/platform-path";
import type {
  AssetDto,
  BoardSummary,
  CardDto,
  ImageCardDto,
  NoteCardDto,
  PathClassificationDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";
import { buildPasteSpecs, readCardClipboard, type CopiedCard } from "./card-clipboard";

/**
 * Paste orchestration that feeds `useCanvasPaste` (todo.md №15/№18/№23): the
 * fallback cursor position, and the path/cards/image/text handlers it calls
 * in that order. `useCanvasPaste` itself only wires the DOM `paste` event and
 * decides which handler applies — the actual card creation lives here.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 6).
 */

export interface PasteActionsOptions {
  board: BoardSummary | null;
  notes: NoteCardDto[];
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
  /** Applies every local card change to the refs and the store together. */
  cardWrites: CardWrites;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  createFolderShortcut: (sourcePath: string, boardX: number, boardY: number) => Promise<void>;
  createFileCard: (
    item: { path: string; fileName: string; mimeType: string },
    boardX: number,
    boardY: number,
  ) => Promise<void>;
  handleCreateNote: (
    position?: { x: number; y: number },
    options?: { startEditing?: boolean; content?: { documentJson: unknown; plainText: string } },
  ) => Promise<void>;
  placeImageAsset: (asset: AssetDto, x: number, y: number, cardId: string, centered?: boolean) => Promise<void>;
  lastCanvasPointRef: RefObject<{ x: number; y: number } | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  boardRef: RefObject<BoardSummary | null>;
  cardsRef: RefObject<CardDto[]>;
}

export interface PasteActionsController {
  handlePastePath: (path: string) => Promise<boolean>;
  handleCanvasPaste: (data: { html: string; text: string }) => void;
  handlePasteCards: () => boolean;
  handlePasteImage: (options?: { onlyIfPresent: boolean }) => Promise<void>;
}

export function usePasteActions(options: PasteActionsOptions): PasteActionsController {
  const {
    board,
    notes,
    gateway,
    dispatch,
    cardWrites,
    dispatcher,
    idGenerator,
    createFolderShortcut,
    createFileCard,
    handleCreateNote,
    placeImageAsset,
    lastCanvasPointRef,
    canvasRef,
    screenToFlowRef,
    boardRef,
    cardsRef,
  } = options;

  // Fallback paste position when the cursor was never over the canvas (e.g.
  // paste fired right after the app opened, before any pointermove) — the
  // center of the visible canvas, not a fixed corner (todo.md №18). Both
  // paste paths below share it so a fix to one can't drift from the other.
  const fallbackPastePosition = useCallback((): { x: number; y: number } => {
    const flow = screenToFlowRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (flow && rect && rect.width > 0 && rect.height > 0) {
      return flow(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    return { x: 40, y: 40 + notes.length * 24 };
    // screenToFlowRef/canvasRef — переданные снаружи refs, вне App линтер не
    // видит их стабильность, указываем явно.
  }, [notes.length, screenToFlowRef, canvasRef]);

  // Paste onto the empty canvas (no editor open) creates a note. `text/html`
  // (Telegram/browser copy) keeps its bold/italic/strike/paragraphs/lists —
  // pasting *into* an open note editor already gets this for free from
  // ProseMirror's own paste handling, so this only covers the canvas-level case.
  // Cmd+V on the empty canvas with a filesystem path on the clipboard
  // (todo.md №23): an existing folder becomes a folder shortcut, an existing
  // file becomes a File Card (copy-in), both under the cursor — same backend
  // calls as native Finder drag-drop. `false` (path missing on disk) tells
  // `useCanvasPaste` to fall through to the normal text/html note paste.
  const handlePastePath = useCallback(
    async (path: string): Promise<boolean> => {
      const currentBoard = boardRef.current;
      if (!currentBoard) return false;
      let classification: PathClassificationDto;
      try {
        classification = await gateway.classifyPath(path);
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
        // The lookup itself failed (not "missing") — do not also fall back to
        // pasting the raw path text as a note; the error banner already
        // surfaced the problem.
        return true;
      }
      if (classification.kind === "missing") return false;

      const cursor = lastCanvasPointRef.current ?? fallbackPastePosition();
      if (classification.kind === "folder") {
        await createFolderShortcut(classification.expandedPath, cursor.x - 180, cursor.y - 150);
      } else {
        const fileName = fileNameFromPath(classification.expandedPath);
        await createFileCard(
          { path: classification.expandedPath, fileName, mimeType: "application/octet-stream" },
          cursor.x,
          cursor.y,
        );
      }
      return true;
    },
    // dispatch стабилен (useReducer), boardRef/lastCanvasPointRef — те же
    // stable refs, что и выше; вне App линтер этого не видит — указываем явно.
    [gateway, createFolderShortcut, createFileCard, fallbackPastePosition, dispatch, boardRef, lastCanvasPointRef],
  );

  const handleCanvasPaste = useCallback(
    ({ html, text }: { html: string; text: string }) => {
      const useHtml = html.trim().length > 0;
      const documentJson = useHtml ? htmlToDocument(html, text) : plainTextToDocument(text);
      const plainText = useHtml ? documentToPlainText(documentJson) : text;
      const position = lastCanvasPointRef.current ?? fallbackPastePosition();
      void handleCreateNote(position, { content: { documentJson, plainText } });
    },
    [handleCreateNote, fallbackPastePosition, lastCanvasPointRef],
  );
  // Paste the internal card clipboard (todo.md №15): duplicates land under the
  // last known cursor position, keeping the copied group's relative layout.
  // One PasteCardsCommand = one undo entry for the whole group.
  const handlePasteCards = useCallback((): boolean => {
    if (!board) return false;
    const copied = readCardClipboard();
    if (!copied || copied.length === 0) return false;
    const cursor = lastCanvasPointRef.current ?? fallbackPastePosition();
    const baseZ = cardsRef.current.length;
    const specs: PasteCardSpec[] = buildPasteSpecs(copied, cursor, board.id, baseZ, () =>
      idGenerator.nextId(),
    );
    const assetById = new Map(
      copied.filter((c): c is Extract<CopiedCard, { kind: "image" }> => c.kind === "image").map((c) => [c.asset.id, c.asset]),
    );
    void (async () => {
      try {
        const { portals, shortcuts } = await dispatcher.execute(
          new PasteCardsCommand(idGenerator.nextId(), specs),
        );
        const portalById = new Map(portals.map((p) => [p.id, p]));
        const shortcutById = new Map(shortcuts.map((s) => [s.id, s]));
        for (const spec of specs) {
          if (spec.kind === "note") {
            const card: NoteCardDto = {
              kind: "note",
              id: spec.id,
              boardId: spec.boardId,
              frame: spec.frame,
              zIndex: spec.zIndex,
              revision: 1,
              documentJson: spec.documentJson,
              plainText: spec.plainText,
              colorToken: spec.colorToken,
            };
            cardWrites.apply({ type: "cardAdded", card });
          } else if (spec.kind === "image") {
            const asset = assetById.get(spec.assetId);
            if (!asset) continue; // unreachable: built from the same copied list
            const card: ImageCardDto = {
              kind: "image",
              id: spec.id,
              boardId: spec.boardId,
              frame: spec.frame,
              zIndex: spec.zIndex,
              revision: 1,
              asset,
              captionJson: spec.captionJson,
              captionPlainText: spec.captionPlainText,
            };
            cardWrites.apply({ type: "cardAdded", card });
          } else if (spec.kind === "shortcut") {
            const card = shortcutById.get(spec.id);
            if (!card) continue; // unreachable: one receipt per shortcut spec
            cardWrites.apply({ type: "cardAdded", card });
          } else {
            // Duplicate-board's title/counts are backend-assigned (ADR-0009):
            // pasted here, not predicted, unlike note/image above.
            const card = portalById.get(spec.id);
            if (!card) continue; // unreachable: one receipt per board spec
            cardWrites.apply({ type: "cardAdded", card });
          }
        }
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    })();
    return true;
    // dispatch стабилен (useReducer), cardsRef/lastCanvasPointRef — те же
    // stable refs, что и выше; вне App линтер этого не видит — указываем явно.
  }, [board, dispatcher, idGenerator, fallbackPastePosition, dispatch, cardsRef, lastCanvasPointRef, cardWrites]);

  // Ctrl/Cmd+V of a bitmap or a copied image file onto the canvas. The backend
  // reads the OS clipboard directly (NSPasteboard on macOS, arboard elsewhere),
  // which also covers file copies from Finder/Explorer that the webview only
  // exposes as an opaque "Files" entry.
  const handlePasteImage = useCallback(async (options?: { onlyIfPresent: boolean }) => {
    const position = lastCanvasPointRef.current ?? fallbackPastePosition();
    try {
      const asset = await gateway.importClipboardImage();
      // Centred under the mouse cursor, like a drop.
      await placeImageAsset(asset, position.x, position.y, idGenerator.nextId(), true);
    } catch (e) {
      // Пробная вставка (пустое событие paste): картинки в буфере нет — это не ошибка.
      if (options?.onlyIfPresent && isNotFound(e)) return;
      dispatch({ type: "failed", message: errorMessage(e) });
    }
    // dispatch стабилен (useReducer), lastCanvasPointRef — тот же stable ref,
    // что и выше; вне App линтер этого не видит — указываем явно.
  }, [gateway, idGenerator, placeImageAsset, fallbackPastePosition, dispatch, lastCanvasPointRef]);

  return { handlePastePath, handleCanvasPaste, handlePasteCards, handlePasteImage };
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "not_found";
}
