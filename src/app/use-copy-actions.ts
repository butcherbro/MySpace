import { useCallback, type Dispatch, type SetStateAction } from "react";
import { copyText } from "../services/clipboard";
import { errorMessage } from "../services/error-message";
import type {
  BoardPortalDto,
  BoardShortcutDto,
  BoardSummary,
  CardDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  WorkspaceGateway,
} from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import { setCardClipboard, type CopiedCard } from "./card-clipboard";

/**
 * Copy-to-clipboard actions: system-clipboard address/path/URL copies
 * ("Copy MySpace Link", "Copy File Path", "Copy URL", a board's own
 * "Copy MySpace Link") plus the canvas selection copy, which writes images to
 * the system clipboard and notes/images/portals/shortcuts to the internal
 * card clipboard for paste.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 5).
 */

export interface CopyActionsOptions {
  /** The card the context menu is open on; without it there is nothing to copy. */
  contextMenu: { cardId: string } | null;
  selection: string[];
  cards: CardDto[];
  board: BoardSummary | null;
  gateway: WorkspaceGateway;
  dispatch: Dispatch<BoardViewAction>;
  setPaneContextMenu: Dispatch<SetStateAction<{ x: number; y: number; flowX: number; flowY: number } | null>>;
}

export interface CopyActionsController {
  handleCopyLink: () => Promise<void>;
  handleCopyFilePath: () => Promise<void>;
  handleCopySourceUrl: () => Promise<void>;
  handleCopyBoardLink: () => Promise<void>;
  handleCopySelectionImages: () => void;
  handleCopySelection: () => void;
}

export function useCopyActions(options: CopyActionsOptions): CopyActionsController {
  const { contextMenu, selection, cards, board, gateway, dispatch, setPaneContextMenu } = options;

  // Copy the stable MySpace address for the right-clicked card (or the current
  // board when invoked from a portal/board context). "Copy MySpace Link" is the
  // universal action; images additionally offer "Copy File Path".
  const handleCopyLink = useCallback(async () => {
    if (!contextMenu) return;
    const card = cards.find((c) => c.id === contextMenu.cardId);
    let address: string;
    if (card?.kind === "board_portal") {
      // A portal is a folder: copy the address of the board it leads to.
      address = `myspace://board/${card.target.id}`;
    } else if (card?.kind === "board_shortcut" && card.target) {
      // A shortcut copies the address of the board it points to, same as a
      // portal — the shortcut card itself has no separate identity to share.
      address = `myspace://board/${card.target.id}`;
    } else if (card) {
      address = `myspace://card/${card.id}`;
    } else {
      address = "";
    }
    try {
      await copyText(address);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
    // dispatch и setPaneContextMenu стабильны (useReducer/useState), но вне App
    // линтер этого не видит — указываем явно.
  }, [contextMenu, cards, dispatch]);

  const handleCopyFilePath = useCallback(async () => {
    if (!contextMenu) return;
    const card = cards.find((c): c is ImageCardDto => c.kind === "image" && c.id === contextMenu.cardId);
    if (!card) return;
    try {
      const path = await gateway.resolveAssetPath(card.asset.id);
      await copyText(path);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, cards, gateway, dispatch]);

  // Copy the actual source URL of a Link Card (embed).
  const handleCopySourceUrl = useCallback(async () => {
    if (!contextMenu) return;
    const card = cards.find((c): c is EmbedCardDto => c.kind === "embed" && c.id === contextMenu.cardId);
    if (!card) return;
    try {
      await copyText(card.sourceUrl);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, cards, dispatch]);

  // Copy the stable address of the currently-open board.
  const handleCopyBoardLink = useCallback(async () => {
    setPaneContextMenu(null);
    if (!board) return;
    try {
      await copyText(`myspace://board/${board.id}`);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [board, setPaneContextMenu, dispatch]);

  // Copy the images of the current selection to the system clipboard.
  const handleCopySelectionImages = useCallback(() => {
    const imageIds = selection.filter((id) => {
      const card = cards.find((c) => c.id === id);
      return card?.kind === "image";
    });
    if (imageIds.length === 0) return;
    void gateway
      .copyImageCards({ cardIds: imageIds })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [selection, cards, gateway, dispatch]);

  // Cmd+C over a canvas selection: fills the internal card clipboard
  // (todo.md №15) with every copyable card (note/image) in the selection, in
  // addition to the existing system-clipboard image copy above (unchanged).
  const handleCopySelection = useCallback(() => {
    const selected = selection
      .map((id) => cards.find((c) => c.id === id))
      .filter(
        (c): c is NoteCardDto | ImageCardDto | BoardPortalDto | BoardShortcutDto =>
          c != null &&
          (c.kind === "note" ||
            c.kind === "image" ||
            c.kind === "board_portal" ||
            // A broken shortcut has no target to copy.
            (c.kind === "board_shortcut" && c.target !== null)),
      );
    if (selected.length > 0) {
      const minX = Math.min(...selected.map((c) => c.frame.x));
      const minY = Math.min(...selected.map((c) => c.frame.y));
      const copied: CopiedCard[] = selected.map((c) => {
        if (c.kind === "note") {
          return {
            kind: "note",
            dx: c.frame.x - minX,
            dy: c.frame.y - minY,
            width: c.frame.width,
            height: c.frame.height,
            documentJson: c.documentJson,
            plainText: c.plainText,
            colorToken: c.colorToken,
          };
        }
        if (c.kind === "image") {
          return {
            kind: "image",
            dx: c.frame.x - minX,
            dy: c.frame.y - minY,
            width: c.frame.width,
            height: c.frame.height,
            asset: c.asset,
            captionJson: c.captionJson,
            captionPlainText: c.captionPlainText,
          };
        }
        if (c.kind === "board_shortcut") {
          return {
            kind: "shortcut",
            dx: c.frame.x - minX,
            dy: c.frame.y - minY,
            width: c.frame.width,
            height: c.frame.height,
            targetBoardId: c.target!.id,
          };
        }
        return {
          kind: "board",
          dx: c.frame.x - minX,
          dy: c.frame.y - minY,
          width: c.frame.width,
          height: c.frame.height,
          sourceBoardId: c.target.id,
        };
      });
      setCardClipboard(copied);
    }
    handleCopySelectionImages();
  }, [selection, cards, handleCopySelectionImages]);

  return {
    handleCopyLink,
    handleCopyFilePath,
    handleCopySourceUrl,
    handleCopyBoardLink,
    handleCopySelectionImages,
    handleCopySelection,
  };
}
