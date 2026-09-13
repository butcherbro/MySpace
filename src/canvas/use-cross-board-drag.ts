import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CardDto } from "../services/workspace-gateway";
import {
  cancelCrossBoardDrag,
  commitCrossBoardDrag,
  createCrossBoardDrag,
  hoverCrossBoardTab,
  moveCrossBoardDrag,
  targetBoardLoaded,
  type CrossBoardDragState,
} from "./cross-board-drag";

/**
 * Cross-board drag session: dragging cards onto a Board tab, opening that board
 * by hovering it, and following the pointer until the drop is resolved.
 *
 * This owns exactly one state machine — the drag gesture — and no commands: it
 * hit-tests the breadcrumb, Quick Boards and Board tab regions, hover-opens a tab
 * after 600 ms, takes over window pointer tracking once React Flow's drag stops
 * firing, and hands the resolved drop back to the caller as a value
 * (`takeDragEnd`). What a drop *means* — a batch move into Unsorted, a portal
 * reparent, a Quick Board pin — stays in `App.tsx`, because that is command
 * orchestration rather than gesture state.
 *
 * Extracted from `App.tsx` unchanged (Task 17, extraction 4 of 6).
 */

const HOVER_OPEN_MS = 600;

export interface CrossBoardDragSessionOptions {
  /** The open board's cards, read at drag time for current revisions. */
  cardsRef: RefObject<ReadonlyArray<CardDto>>;
  /** The board under the pointer, tracked per move. */
  boardRef: RefObject<{ id: string } | null>;
  /** The current selection: dragging a member drags the whole group. */
  selectionRef: RefObject<string[]>;
  /** Screen-to-canvas conversion, absent until the canvas registers it. */
  screenToFlowRef: RefObject<((x: number, y: number) => { x: number; y: number }) | null>;
  /** Opens the hovered board. */
  navigateTo: (
    boardId: string,
    options: { pushHistory?: boolean; tabMode?: "open" | "sync" },
  ) => Promise<void>;
}

/** A previewing cross-board drag, resolved far enough to commit. */
export interface CrossBoardDrop {
  drag: CrossBoardDragState;
  targetBoardId: string;
  /** Where the pointer released, in canvas coordinates. */
  frame: { x: number; y: number; width: number; height: number };
}

export interface CrossBoardDragEnd {
  cardId: string | null;
  groupIds: string[];
  overQuickBoards: boolean;
  dropTargetBoardId: string | null;
  /** Set only when the drag reached the previewing phase over the hovered tab. */
  crossBoard: CrossBoardDrop | null;
  /** Keeps the previewed cards where they landed. */
  commitCrossBoard: () => void;
  /** Returns the preview to its source board. */
  cancelCrossBoard: () => void;
}

export interface CrossBoardDragSession {
  /** The session to render (ghost overlay), or null. */
  drag: CrossBoardDragState | null;
  /** The breadcrumb board under the pointer, for highlighting. */
  dropTargetBoardId: string | null;
  /** Whether a Board Portal drag is over the Quick Boards rail. */
  overQuickBoards: boolean;
  onDragMove: (event: { cardId: string; clientX: number; clientY: number }) => void;
  /** Reads the gesture's outcome and clears it; the caller resolves the drop. */
  takeDragEnd: () => CrossBoardDragEnd;
  /** The resolver window pointer tracking calls once the target board opened. */
  setDragEndResolver: (resolver: (() => boolean) | null) => void;
}

export function useCrossBoardDragSession(
  options: CrossBoardDragSessionOptions,
): CrossBoardDragSession {
  const { cardsRef, boardRef, selectionRef, screenToFlowRef, navigateTo } = options;

  const [drag, setDrag] = useState<CrossBoardDragState | null>(null);
  const dragRef = useRef<CrossBoardDragState | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  const [dropTargetBoardId, setDropTargetBoardId] = useState<string | null>(null);
  // The hovered breadcrumb board id, mirrored to a ref so the continuous drag
  // gesture can read it synchronously. React batches `setDropTargetBoardId`,
  // and React Flow fires `onNodeDragStop` right after the final `onNodeDrag` in
  // the same pointer gesture, so state alone is too stale to resolve the drop.
  const dropTargetBoardIdRef = useRef<string | null>(null);

  // Whether the pointer is over the Quick Boards region during a Board Portal
  // drag, so a drop pins a reference instead of reparenting the Board.
  const overQuickBoardsRef = useRef(false);
  const [overQuickBoards, setOverQuickBoards] = useState(false);

  // All card ids of an in-flight drag (a group when the dragged card is part of
  // a multi-selection). Populated on drag start, cleared on drag end.
  const lastDraggedCardIdRef = useRef<string | null>(null);
  const draggedCardIdsRef = useRef<string[]>([]);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  // Once the target board opens (previewing), React Flow's drag stops firing, so
  // we take over pointer tracking on window: the ghost follows the cursor and
  // pointerup resolves the drop.
  const windowMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const windowUpRef = useRef<((e: PointerEvent) => void) | null>(null);
  const dragEndResolverRef = useRef<(() => boolean) | null>(null);

  const cleanupWindowTracking = useCallback(() => {
    if (windowMoveRef.current) {
      window.removeEventListener("pointermove", windowMoveRef.current);
      windowMoveRef.current = null;
    }
    if (windowUpRef.current) {
      window.removeEventListener("pointerup", windowUpRef.current);
      windowUpRef.current = null;
    }
  }, []);

  useEffect(() => cleanupWindowTracking, [cleanupWindowTracking]);

  const startWindowTracking = useCallback(() => {
    cleanupWindowTracking();
    const move = (e: PointerEvent) => {
      const active = dragRef.current;
      if (!active) return;
      const pointerBoardId = boardRef.current?.id ?? null;
      setDrag((prev) =>
        prev ? moveCrossBoardDrag(prev, { x: e.clientX, y: e.clientY }, pointerBoardId) : prev,
      );
    };
    const up = () => {
      cleanupWindowTracking();
      dragEndResolverRef.current?.();
    };
    windowMoveRef.current = move;
    windowUpRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [boardRef, cleanupWindowTracking]);

  const onDragMove = useCallback(
    (event: { cardId: string; clientX: number; clientY: number }) => {
      lastDraggedCardIdRef.current = event.cardId;
      // A drag of a card inside a multi-selection moves the whole selection.
      const selection = selectionRef.current;
      const groupIds =
        selection.includes(event.cardId) && selection.length > 1 ? selection : [event.cardId];
      draggedCardIdsRef.current = groupIds;

      // Start a cross-board drag session on the first real move of a card. A
      // lingering finished/cancelled session (effect may resync ref from state)
      // must not block a new drag.
      const previous = dragRef.current;
      if (!previous || previous.phase === "cancelled" || previous.phase === "committing") {
        const card = cardsRef.current.find((c) => c.id === event.cardId);
        if (card) {
          const snapshots = groupIds
            .map((id) => cardsRef.current.find((c) => c.id === id))
            .filter((c): c is CardDto => Boolean(c))
            .map((c) => ({
              cardId: c.id,
              kind: c.kind,
              width: c.frame.width,
              height: c.frame.height,
              label:
                c.kind === "note"
                  ? c.plainText || "Note"
                  : c.kind === "filesystem_alias"
                    ? c.displayName
                    : c.kind,
              revision: c.revision,
              boardId: c.boardId,
              frame: { ...c.frame },
              targetBoardId: c.kind === "board_portal" ? c.target.id : undefined,
              boardRevision: c.kind === "board_portal" ? c.target.boardRevision : undefined,
            }));
          const created = createCrossBoardDrag(snapshots, card.boardId);
          dragRef.current = created;
          setDrag(created);
        }
      }

      const el = document.elementFromPoint(event.clientX, event.clientY);
      const crumbEl = el?.closest?.("[data-board-drop-id]") as HTMLElement | null;
      const boardId = crumbEl?.getAttribute("data-board-drop-id") ?? null;
      dropTargetBoardIdRef.current = boardId;
      setDropTargetBoardId(boardId);

      // Also hit-test the Quick Boards region so a Board Portal drop there pins a
      // reference instead of reparenting the Board.
      const quickEl = el?.closest?.("[data-quick-boards-drop]") as HTMLElement | null;
      const overQuick = Boolean(quickEl);
      overQuickBoardsRef.current = overQuick;
      setOverQuickBoards(overQuick);

      // Cross-board: hit-test a Board tab. Hovering a tab for 600ms opens that
      // board so the drag can continue inside it (ghost follows the cursor).
      const tabEl = el?.closest?.("[data-testid='board-tab']") as HTMLElement | null;
      const tabBoardId = tabEl?.getAttribute("data-board-id") ?? null;
      const active = dragRef.current;
      if (!active) return;

      // Track the board under the pointer (the currently open board's id).
      const pointerBoardId = boardRef.current?.id ?? null;
      setDrag((prev) =>
        prev ? moveCrossBoardDrag(prev, { x: event.clientX, y: event.clientY }, pointerBoardId) : prev,
      );
      if (tabBoardId && tabBoardId !== active.sourceBoardId) {
        if (active.hoverBoardId !== tabBoardId) {
          setDrag((prev) => (prev ? hoverCrossBoardTab(prev, tabBoardId) : prev));
          clearHoverTimer();
          hoverTimerRef.current = setTimeout(() => {
            void navigateTo(tabBoardId, { tabMode: "open" }).then(() => {
              setDrag((prev) => (prev ? targetBoardLoaded(prev) : prev));
              // React Flow's drag stops after the snapshot swap; take over on
              // window so the ghost keeps following and pointerup resolves.
              startWindowTracking();
            });
          }, HOVER_OPEN_MS);
        }
      } else {
        clearHoverTimer();
      }
    },
    [
      boardRef,
      cardsRef,
      clearHoverTimer,
      navigateTo,
      selectionRef,
      startWindowTracking,
    ],
  );

  const takeDragEnd = useCallback((): CrossBoardDragEnd => {
    cleanupWindowTracking();

    const cardId = lastDraggedCardIdRef.current;
    const dropTargetBoard = dropTargetBoardIdRef.current;
    const overQuick = overQuickBoardsRef.current;
    const groupIds = draggedCardIdsRef.current;
    dropTargetBoardIdRef.current = null;
    overQuickBoardsRef.current = false;
    setDropTargetBoardId(null);
    setOverQuickBoards(false);
    lastDraggedCardIdRef.current = null;
    draggedCardIdsRef.current = [];

    const unresolved: CrossBoardDragEnd = {
      cardId,
      groupIds,
      overQuickBoards: overQuick,
      dropTargetBoardId: dropTargetBoard,
      crossBoard: null,
      commitCrossBoard: () => {},
      cancelCrossBoard: () => {},
    };

    // Cross-board drag: resolve the final drop. Only a drag that actually
    // reached the previewing phase (a tab was hovered and its board opened)
    // consumes the drop; otherwise fall through to the normal move path.
    const active = dragRef.current;
    if (!active) return unresolved;

    clearHoverTimer();
    const target = active.hoverBoardId;
    // A board portal dropped onto a tab reparents the board even if the pointer
    // is still over the tab (not yet on the canvas). The tab itself is the
    // target.
    const isBoardPortal = active.ghostCard?.kind === "board_portal";
    const overTab = active.pointerBoardId === target || isBoardPortal;
    const ghost = active.ghostCard;
    if (active.phase === "previewing" && target && overTab && ghost) {
      // Consume the session immediately so a duplicated drag-end call (React
      // Flow onNodeDragStop + our window pointerup) cannot commit twice.
      dragRef.current = null;
      const flow = screenToFlowRef.current;
      const point = flow ? flow(active.pointer.x, active.pointer.y) : { x: 40, y: 40 };
      return {
        ...unresolved,
        dropTargetBoardId: target,
        crossBoard: {
          drag: active,
          targetBoardId: target,
          frame: {
            x: point.x - ghost.width / 2,
            y: point.y - ghost.height / 2,
            width: ghost.width,
            height: ghost.height,
          },
        },
        commitCrossBoard: () => {
          setDrag(commitCrossBoardDrag(active));
          dragRef.current = null;
        },
        cancelCrossBoard: () => {
          setDrag(cancelCrossBoardDrag(active));
          dragRef.current = null;
        },
      };
    }

    // Not consumed: clear the drag session and let the normal path run.
    setDrag(null);
    dragRef.current = null;
    return unresolved;
  }, [cleanupWindowTracking, clearHoverTimer, screenToFlowRef]);

  const setDragEndResolver = useCallback((resolver: (() => boolean) | null) => {
    dragEndResolverRef.current = resolver;
  }, []);

  return {
    drag,
    dropTargetBoardId,
    overQuickBoards,
    onDragMove,
    takeDragEnd,
    setDragEndResolver,
  };
}
