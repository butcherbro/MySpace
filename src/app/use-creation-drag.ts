import { useCallback, useRef, useState, type Dispatch, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import type { BoardSummary, CardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";

/** A tool draggable out of the rail: Note, Link, and Board (Image uses a file picker). */
export type ToolKind = "note" | "link" | "board";

/**
 * The two pointer-driven drags that place a card on the canvas without going
 * through React Flow's own drag handling: dragging a card out of the Unsorted
 * panel, and dragging a tool out of the rail to create it at the drop point.
 * Both track the pointer on `window` and clean up their own listeners on
 * release.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 8).
 */

export interface CreationDragDeps {
  unsortedCards: CardDto[];
  cards: CardDto[];
  board: BoardSummary | null;
  gateway: WorkspaceGateway;
  dispatch: Dispatch<CurrentBoardAction>;
  /** Applies every write answer to `cardsRef` and the store together. */
  cardWrites: CardWrites;
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  handleCreateNote: (position?: { x: number; y: number }) => void | Promise<void>;
  handleCreateLink: (position?: { x: number; y: number }) => void;
  handleCreateChildBoard: (position?: { x: number; y: number }) => void | Promise<void>;
}

export interface CreationDragController {
  unsortedGhost: { cardId: string; x: number; y: number } | null;
  handlePlaceUnsortedCard: (cardId: string) => void;
  handleUnsortedPointerDown: (cardId: string, clientX: number, clientY: number) => void;
  createGhost: { x: number; y: number; kind: ToolKind } | null;
  handleCreationDragStart: (kind: ToolKind, clientX: number, clientY: number) => void;
}

export function useCreationDrag(deps: CreationDragDeps): CreationDragController {
  const {
    unsortedCards,
    cards,
    board,
    gateway,
    dispatch,
    cardWrites,
    screenToFlowRef,
    handleCreateNote,
    handleCreateLink,
    handleCreateChildBoard,
  } = deps;

  // Distribute one Unsorted card onto the canvas at a free cascading slot.
  const handlePlaceUnsortedCard = useCallback(
    (cardId: string) => {
      const card = unsortedCards.find((c) => c.id === cardId);
      if (!card || !board) return;
      const maxBottom = cards.reduce((max, c) => Math.max(max, c.frame.y + c.frame.height), 0);
      const frame = {
        x: 40,
        y: maxBottom > 0 ? maxBottom + 24 : 40,
        width: card.frame.width,
        height: card.frame.height,
      };
      void gateway
        .placeUnsortedCard({ id: cardId, expectedRevision: card.revision, frame })
        .then((receipt) => {
          cardWrites.apply({
            type: "unsortedCardPlaced",
            id: cardId,
            frame,
            revision: receipt.revision,
          });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [unsortedCards, cards, board, gateway, dispatch, cardWrites],
  );

  // Pointer-drag a card out of the Unsorted panel onto the canvas: track the
  // pointer on window, show a ghost, and place the card exactly where it is
  // released if that is over the canvas.
  const unsortedDragCardIdRef = useRef<string | null>(null);
  const [unsortedGhost, setUnsortedGhost] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const unsortedGhostMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const unsortedGhostUpRef = useRef<((e: PointerEvent) => void) | null>(null);

  const cleanupUnsortedDrag = useCallback(() => {
    if (unsortedGhostMoveRef.current) {
      window.removeEventListener("pointermove", unsortedGhostMoveRef.current);
      unsortedGhostMoveRef.current = null;
    }
    if (unsortedGhostUpRef.current) {
      window.removeEventListener("pointerup", unsortedGhostUpRef.current);
      unsortedGhostUpRef.current = null;
    }
    unsortedDragCardIdRef.current = null;
    setUnsortedGhost(null);
  }, []);

  const handleUnsortedPointerDown = useCallback(
    (cardId: string, clientX: number, clientY: number) => {
      unsortedDragCardIdRef.current = cardId;
      setUnsortedGhost({ cardId, x: clientX, y: clientY });

      const move = (e: PointerEvent) =>
        setUnsortedGhost((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev));
      const up = (e: PointerEvent) => {
        const id = unsortedDragCardIdRef.current;
        cleanupUnsortedDrag();
        if (!id) return;
        // Place only if released over the canvas.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overCanvas = Boolean(el?.closest?.('[data-testid="canvas"]'));
        if (!overCanvas) return;
        const card = unsortedCards.find((c) => c.id === id);
        if (!card) return;
        const flow = screenToFlowRef.current;
        const point = flow ? flow(e.clientX, e.clientY) : { x: 40, y: 40 };
        const frame = {
          x: point.x - card.frame.width / 2,
          y: point.y - card.frame.height / 2,
          width: card.frame.width,
          height: card.frame.height,
        };
        void gateway
          .placeUnsortedCard({ id, expectedRevision: card.revision, frame })
          .then((receipt) => {
            cardWrites.apply({
              type: "unsortedCardPlaced",
              id,
              frame,
              revision: receipt.revision,
            });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
      };

      unsortedGhostMoveRef.current = move;
      unsortedGhostUpRef.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [unsortedCards, gateway, cleanupUnsortedDrag, dispatch, cardWrites, screenToFlowRef],
  );

  // Drag-to-create a tool out of the rail: on release over the canvas, the item
  // is created at the drop point; a plain click still creates in the default
  // location. Handles Note, Link, and Board (Image uses a file picker).
  const createGhostRef = useRef<{ x: number; y: number; kind: ToolKind } | null>(null);
  const [createGhost, setCreateGhost] = useState<{ x: number; y: number; kind: ToolKind } | null>(null);
  const createDragMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const createDragUpRef = useRef<((e: PointerEvent) => void) | null>(null);

  const cleanupCreationDrag = useCallback(() => {
    if (createDragMoveRef.current) {
      window.removeEventListener("pointermove", createDragMoveRef.current);
      createDragMoveRef.current = null;
    }
    if (createDragUpRef.current) {
      window.removeEventListener("pointerup", createDragUpRef.current);
      createDragUpRef.current = null;
    }
    createGhostRef.current = null;
    setCreateGhost(null);
  }, []);

  const handleCreationDragStart = useCallback(
    (kind: ToolKind, clientX: number, clientY: number) => {
      createGhostRef.current = { x: clientX, y: clientY, kind };
      setCreateGhost({ x: clientX, y: clientY, kind });
      let moved = false;
      const move = (e: PointerEvent) => {
        moved = true;
        createGhostRef.current = { x: e.clientX, y: e.clientY, kind };
        setCreateGhost({ x: e.clientX, y: e.clientY, kind });
      };
      const up = (e: PointerEvent) => {
        cleanupCreationDrag();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overCanvas = Boolean(el?.closest?.('[data-testid="canvas"]'));
        const flow = screenToFlowRef.current;
        const point = flow ? flow(e.clientX, e.clientY) : { x: 200, y: 120 };
        if (!overCanvas) {
          // Plain click on the rail falls back to the default placement.
          if (!moved) {
            if (kind === "note") void handleCreateNote();
            else if (kind === "link") void handleCreateLink();
            else if (kind === "board") void handleCreateChildBoard();
          }
          return;
        }
        if (kind === "note") void handleCreateNote({ x: point.x - 120, y: point.y - 60 });
        else if (kind === "link") void handleCreateLink({ x: point.x - 120, y: point.y - 60 });
        else if (kind === "board") void handleCreateChildBoard({ x: point.x - 60, y: point.y - 56 });
      };
      createDragMoveRef.current = move;
      createDragUpRef.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [cleanupCreationDrag, handleCreateNote, handleCreateLink, handleCreateChildBoard, screenToFlowRef],
  );

  return {
    unsortedGhost,
    handlePlaceUnsortedCard,
    handleUnsortedPointerDown,
    createGhost,
    handleCreationDragStart,
  };
}
