import { useCallback, useEffect, type Dispatch, type RefObject } from "react";
import { errorMessage } from "../services/error-message";
import type { IdGenerator } from "../services/id-generator";
import type { CommandDispatcher } from "../commands/command-dispatcher";
import { MoveCardsCommand, MoveCardToBoardCommand } from "../commands/card-commands";
import { MoveBoardCommand } from "../commands/board-commands";
import { moveSelectionOntoBoard } from "../canvas/move-selection-onto-board";
import type { useCrossBoardDragSession } from "../canvas/use-cross-board-drag";
import type { CanvasCard } from "../canvas/canvas-types";
import type { MutationQueue } from "../persistence/entity-write-queue";
import type { BoardPortalDto, BoardSummary, CardDto, WorkspaceGateway } from "../services/workspace-gateway";
import type { BoardViewAction } from "../state/current-board-store";
import type { CardWrites } from "../state/card-writes";
import type { useBoardNavigation } from "../navigation/use-board-navigation";

/**
 * Card moves and drops: on-canvas moves (one undo entry per gesture), a drop
 * onto a board portal, a group drop onto a portal or breadcrumb, and the end of
 * a cross-board drag (tab drop, Quick Boards pin). Registers the drag-end
 * resolver with the cross-board drag session.
 *
 * Called after `useCrossBoardDragSession` and `useBoardNavigation`: it needs the
 * session and `navigateTo`.
 *
 * Extracted from `App.tsx` unchanged (docs/plans/2026-09-26-app-tsx-split.md, step 10).
 */

export interface CardDropDeps {
  gateway: WorkspaceGateway;
  dispatcher: CommandDispatcher;
  idGenerator: IdGenerator;
  dispatch: Dispatch<BoardViewAction>;
  /** Applies every write answer to `cardsRef` and the store together. */
  cardWrites: CardWrites;
  queueRef: RefObject<MutationQueue>;
  cardsRef: RefObject<CardDto[]>;
  boardRef: RefObject<BoardSummary | null>;
  crossBoardDragSession: ReturnType<typeof useCrossBoardDragSession>;
  navigateTo: ReturnType<typeof useBoardNavigation>["navigateTo"];
  handleQuickBoardPin: (boardId: string) => void;
}

export function useCardDrop(deps: CardDropDeps) {
  const {
    gateway,
    dispatcher,
    idGenerator,
    dispatch,
    cardWrites,
    queueRef,
    cardsRef,
    boardRef,
    crossBoardDragSession,
    navigateTo,
    handleQuickBoardPin,
  } = deps;

  const handleCardsMoved = useCallback(
    (e: { cards: Array<{ id: string; frame: CanvasCard["frame"] }> }) => {
      void queueRef.current
        .run(async () => {
          const moves = e.cards
            .map((moved) => {
              const card = cardsRef.current.find((c) => c.id === moved.id);
              return card
                ? {
                    id: moved.id,
                    revision: card.revision,
                    before: card.frame,
                    after: moved.frame,
                  }
                : null;
            })
            .filter(
              (x): x is { id: string; revision: number; before: CanvasCard["frame"]; after: CanvasCard["frame"] } =>
                x !== null,
            );

          if (moves.length === 0) return;

          // One gesture = one undo entry via the dispatcher.
          const receipt = await dispatcher.execute(
            new MoveCardsCommand(idGenerator.nextId(), moves),
          );
          const revisionById = new Map(receipt.cards.map((c) => [c.id, c.revision]));

          for (const item of moves) {
            const revision = revisionById.get(item.id);
            if (revision === undefined) continue; // unreachable: one receipt per requested card
            cardWrites.apply({
              type: "cardMoved",
              id: item.id,
              revision,
              frame: item.after,
            });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [idGenerator, dispatcher, dispatch, cardWrites, queueRef, cardsRef],
  );

  // Moving a card onto a board portal. A leaf card (note/image/embed) changes
  // board via moveCardToBoard; a board_portal reparents the underlying board via
  // the undoable MoveBoardCommand. After a successful move the card no longer
  // belongs to the current projection, so remove it from local state.
  const handleCardDroppedOnPortal = useCallback(
    (cardId: string, targetBoardId: string) => {
      const card = cardsRef.current.find((c) => c.id === cardId);
      if (!card) return;

      if (card.kind === "board_portal") {
        const portal = card;
        const prevParent = portal.boardId;
        const prevFrame = portal.frame;
        const nextFrame = { x: 40, y: 40, width: portal.frame.width, height: portal.frame.height };
        void dispatcher
          .execute(
            new MoveBoardCommand(
              idGenerator.nextId(),
              portal.target.id,
              prevParent,
              prevFrame,
              targetBoardId,
              nextFrame,
              portal.target.boardRevision,
              portal.revision,
            ),
          )
          .then(() => {
            cardWrites.apply({ type: "cardsRemoved", ids: [cardId] });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
        return;
      }

      // Blind drop of a leaf card into a board: it lands in that board's
      // Unsorted panel (Milanote-style) instead of stacking at the origin.
      //
      // Routed through moveSelectionOntoBoard/MoveSelectionCommand (the same
      // path the group drop below uses) instead of calling the gateway
      // directly: a raw gateway call never entered the dispatcher's undo
      // stack, so Cmd+Z after this specific drop undid whatever OLDER command
      // happened to be on top instead — which had usually gone stale by then,
      // surfacing as an unrelated "stale_revision" toast and no visible
      // change (tasks/lessons.md 2026-09-18).
      void moveSelectionOntoBoard({
        gateway,
        dispatcher,
        idGenerator,
        targetBoardId,
        leafCards: [card],
        portals: [],
      })
        .then((receipt) => {
          // If the target is the currently open board, show it in its Unsorted
          // panel; otherwise the card simply left this board (it will appear in
          // the target board's Unsorted when that board is opened).
          if (receipt.targetBoardId === boardRef.current?.id) {
            const moved = receipt.cards.find((c) => c.id === cardId);
            if (moved) {
              cardWrites.apply({ type: "cardMovedToUnsorted", id: cardId, revision: moved.afterRevision });
            }
          } else {
            cardWrites.apply({ type: "cardsRemoved", ids: [cardId] });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [gateway, dispatcher, idGenerator, dispatch, cardWrites, cardsRef, boardRef],
  );

  // Group drop onto a board (portal or breadcrumb): leaf cards move as one batch
  // into the target's Unsorted panel; board portals reparent one by one.
  const handleCardsDroppedOnBoard = useCallback(
    (ids: string[], targetBoardId: string) => {
      const cards = ids
        .map((id) => cardsRef.current.find((c) => c.id === id))
        .filter((c): c is CardDto => Boolean(c));

      const leafCards = cards.filter((c) => c.kind !== "board_portal");
      // The destination board is NOT filtered out here: ADR-0007 makes the
      // backend refuse the whole operation when the selection contains it, so the
      // user gets a reason instead of a silently shrunken selection.
      const portals = cards.filter((c): c is BoardPortalDto => c.kind === "board_portal");

      if (leafCards.length > 0 || portals.length > 0) {
        // One atomic call for the whole selection, and the state is mirrored from
        // the receipt the backend returned rather than recomputed locally.
        const currentBoardId = boardRef.current?.id;
        // moveSelectionOntoBoard refreshes each leaf's revision via readCard and
        // retries once on a stale-revision refusal: a draft save (blur flush) can
        // still land in the gap between that refresh and the move's own IPC call,
        // especially for a large note whose write is slower than the drag gesture
        // (tasks/lessons.md 2026-09-08; tasks/lessons.md 2026-09-18).
        void moveSelectionOntoBoard({
          gateway,
          dispatcher,
          idGenerator,
          targetBoardId,
          leafCards,
          portals: portals.map((p) => ({
            boardId: p.target.id,
            boardRevision: p.target.boardRevision,
            portalRevision: p.revision,
          })),
        })
          .then((receipt) => {
            if (receipt.cards.length > 0) {
              if (receipt.targetBoardId === currentBoardId) {
                for (const card of receipt.cards) {
                  cardWrites.apply({ type: "cardMovedToUnsorted", id: card.id, revision: card.afterRevision });
                }
              } else {
                cardWrites.apply({ type: "cardsRemoved", ids: receipt.cards.map((card) => card.id) });
              }
            }
            // Дроп на крошку открытой доски: портал остаётся здесь, но бэкенд
            // переставил его и поднял обе ревизии — без этого он висит на старом
            // месте до перезагрузки, а следующий его перенос падает с stale_revision.
            if (receipt.targetBoardId === currentBoardId) {
              for (const board of receipt.boards) {
                cardWrites.apply({
                  type: "portalMoved",
                  id: board.portalCardId,
                  revision: board.afterPortalRevision,
                  boardRevision: board.afterBoardRevision,
                  frame: board.destinationPortalFrame,
                });
              }
            }
            const departed = receipt.boards
              .filter(
                (board) =>
                  board.previousParentBoardId === currentBoardId &&
                  receipt.targetBoardId !== currentBoardId,
              )
              .map((board) => board.portalCardId);
            if (departed.length > 0) cardWrites.apply({ type: "cardsRemoved", ids: departed });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
      }
    },
    [gateway, dispatcher, idGenerator, dispatch, cardWrites, cardsRef, boardRef],
  );

  const handleCardDragEnd = useCallback((): boolean => {
    const drop = crossBoardDragSession.takeDragEnd();
    const { cardId, groupIds, overQuickBoards: overQuick, dropTargetBoardId: targetBoardId } = drop;

    {
      const resolved = drop.crossBoard;
      const drag = resolved?.drag;
      const target = resolved?.targetBoardId;
      const gc = drag?.ghostCard;
      if (resolved && drag && target && gc) {
        const frame = resolved.frame;

          // Group move onto a tab: every leaf card goes into the target's
          // Unsorted panel as one batch; any board portals reparent one by one.
          if (drag.cardIds.length > 1) {
            const leafSanps = drag.cards.filter((c) => c.kind !== "board_portal");
            const portals = drag.cards.filter(
              (
                c,
              ): c is (typeof drag.cards)[number] & {
                targetBoardId: string;
                boardRevision: number;
              } =>
                c.kind === "board_portal" &&
                c.targetBoardId !== undefined &&
                c.boardRevision !== undefined,
            );

            const finish = () => {
              drop.commitCrossBoard();
              void navigateTo(target, { tabMode: "sync" });
            };

            if (leafSanps.length > 0 || portals.length > 0) {
              // Same retry-on-stale-revision helper as the on-canvas portal drop:
              // a draft flush (blur) can still bump a leaf's revision in the gap
              // between the readCard refresh and this call's own IPC round-trip.
              void moveSelectionOntoBoard({
                gateway,
                dispatcher,
                idGenerator,
                targetBoardId: target,
                leafCards: leafSanps.map((c) => ({ id: c.cardId, revision: c.revision })),
                portals: portals.map((p) => ({
                  boardId: p.targetBoardId,
                  boardRevision: p.boardRevision,
                  portalRevision: p.revision,
                })),
              })
                .then(finish)
                .catch((err) => {
                  dispatch({ type: "failed", message: errorMessage(err) });
                  drop.cancelCrossBoard();
                });
            } else {
              finish();
            }
            return true; // consumed
          }

          // A board portal reparents its underlying board (moveBoard), not the
          // leaf-card move path. Reuse the same MoveBoardCommand as a portal
          // dropped onto another portal on the canvas.
          if (gc.kind === "board_portal" && gc.targetBoardId && gc.boardRevision !== undefined) {
            void dispatcher
              .execute(
                new MoveBoardCommand(
                  idGenerator.nextId(),
                  gc.targetBoardId,
                  gc.boardId,
                  gc.frame,
                  target,
                  frame,
                  gc.boardRevision,
                  gc.revision,
                ),
              )
              .then(() => {
                drop.commitCrossBoard();
                void navigateTo(target, { tabMode: "sync" });
              })
              .catch((err) => {
                dispatch({ type: "failed", message: errorMessage(err) });
                drop.cancelCrossBoard();
              });
            return true; // consumed
          }

          // The card's revision may have moved since drag start (e.g. a draft
          // save on blur); read the current revision before committing.
          void gateway
            .readCard(gc.cardId)
            .then((fresh) => {
              const revision =
                fresh && "revision" in fresh ? (fresh as { revision: number }).revision : gc.revision;
              return dispatcher.execute(
                new MoveCardToBoardCommand(
                  idGenerator.nextId(),
                  gc.cardId,
                  gc.boardId,
                  gc.frame,
                  revision,
                  target,
                  frame,
                ),
              );
            })
            .then(() => {
              drop.commitCrossBoard();
              // Reload the target board so the placed card appears immediately
              // (its snapshot was loaded before the move; the card now lives
              // there, so a plain cardsRemoved would wrongly hide it).
              void navigateTo(target, { tabMode: "sync" });
            })
            .catch((err) => {
              dispatch({ type: "failed", message: errorMessage(err) });
              drop.cancelCrossBoard();
            });
          return true; // consumed
        }
      }

    if (cardId && overQuick) {
      // Pin the dragged Board Portal as a Quick Board reference (no move/reparent).
      const card = cardsRef.current.find((c) => c.id === cardId);
      if (card?.kind === "board_portal") {
        handleQuickBoardPin(card.target.id);
        return true; // consumed: do not also persist a plain reposition
      }
      // Quick Boards only accepts Board Portals. A leaf card dragged across the
      // rail must still follow the normal canvas-position persistence path.
    }
    if (cardId && targetBoardId) {
      handleCardsDroppedOnBoard(groupIds.length > 0 ? groupIds : [cardId], targetBoardId);
      return true; // consumed: moved to a portal/breadcrumb
    }
    return false;
  }, [
    crossBoardDragSession,
    handleCardsDroppedOnBoard,
    handleQuickBoardPin,
    gateway,
    dispatcher,
    idGenerator,
    navigateTo,
    dispatch,
    cardsRef,
  ]);

  // The session resolves the drop through this callback once its window pointer
  // tracking sees the release.
  useEffect(() => {
    crossBoardDragSession.setDragEndResolver(handleCardDragEnd);
  }, [crossBoardDragSession, handleCardDragEnd]);

  return { handleCardsMoved, handleCardDroppedOnPortal, handleCardsDroppedOnBoard, handleCardDragEnd };
}
