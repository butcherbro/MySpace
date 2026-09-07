import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { CanvasAdapter } from "./canvas/CanvasAdapter";
import {
  cancelCrossBoardDrag,
  commitCrossBoardDrag,
  createCrossBoardDrag,
  hoverCrossBoardTab,
  moveCrossBoardDrag,
  targetBoardLoaded,
  type CrossBoardDragState,
} from "./canvas/cross-board-drag";
import type { CanvasCard, CanvasViewport } from "./canvas/canvas-types";
import { renderCard as renderCardFromRegistry } from "./cards/card-registry";
import { MoveCardsCommand, CreateNoteCommand, MoveCardToBoardCommand } from "./commands/card-commands";
import { CreateChildBoardCommand, MoveBoardCommand, RenameBoardCommand } from "./commands/board-commands";
import { CommandDispatcher } from "./commands/command-dispatcher";
import { TrashSelectionCommand } from "./commands/trash-commands";
import { CanvasErrorBanner } from "./components/errors/CanvasErrorBanner";
import { ToolRail } from "./components/tool-rail/ToolRail";
import { plainTextToDocument, documentToPlainText, normalizeDocument } from "./editor/document-codec";
import { classifyLinkConversion } from "./cards/link/link-conversion";
import { BoardBreadcrumbs } from "./navigation/BoardBreadcrumbs";
import { BoardTabs } from "./navigation/BoardTabs";
import { QuickBoardsRail } from "./navigation/QuickBoardsRail";
import { UndoRedoControls } from "./navigation/UndoRedoControls";
import { UnsortedPanel } from "./navigation/UnsortedPanel";
import {
  activateBoardTab,
  createBoardTabs,
  closeBoardTab,
  navigateBoardTab,
  type BoardTab,
  type BoardTabsState,
} from "./navigation/board-tabs";
import { BoardHistory } from "./navigation/board-history";
import { MutationQueue } from "./persistence/entity-write-queue";
import { createGateway } from "./services/create-gateway";
import { errorMessage } from "./services/error-message";
import { UuidV7Generator, type IdGenerator } from "./services/id-generator";
import { pickImageFile } from "./services/asset-picker";
import { subscribeToImageDrops } from "./services/drag-drop";
import { copyText } from "./services/clipboard";
import type {
  BoardPortalDto,
  EmbedCardDto,
  ImageCardDto,
  NoteCardDto,
  QuickBoardDto,
  WorkspaceGateway,
} from "./services/workspace-gateway";
import {
  initialState,
  reducer,
} from "./state/current-board-store";

function App() {
  const gateway: WorkspaceGateway = useMemo(() => createGateway(), []);
  const idGenerator: IdGenerator = useMemo(() => new UuidV7Generator(), []);

  const [state, dispatch] = useReducer(reducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [paneContextMenu, setPaneContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [highlightedPortalId, setHighlightedPortalId] = useState<string | null>(null);
  const [dropTargetBoardId, setDropTargetBoardId] = useState<string | null>(null);
  // The hovered breadcrumb board id, mirrored to a ref so the continuous drag
  // gesture can read it synchronously. React batches `setDropTargetBoardId`,
  // and React Flow fires `onNodeDragStop` right after the final `onNodeDrag` in
  // the same pointer gesture, so state alone is too stale to resolve the drop.
  const dropTargetBoardIdRef = useRef<string | null>(null);
  // Whether the pointer is over the Quick Boards region during a Board Portal
  // drag, so a drop pins a reference instead of reparenting the Board.
  const overQuickBoardsRef = useRef<boolean>(false);
  const [dropActiveQuickBoards, setDropActiveQuickBoards] = useState(false);

  // Cross-board drag: app-owned state machine for dragging cards onto a Board
  // tab, opening that board, and dropping into its Unsorted panel.
  const [crossBoardDrag, setCrossBoardDrag] = useState<CrossBoardDragState | null>(null);
  const crossBoardDragRef = useRef<CrossBoardDragState | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    crossBoardDragRef.current = crossBoardDrag;
  }, [crossBoardDrag]);

  // Once the target board opens (previewing), React Flow's drag stops firing, so
  // we take over pointer tracking on window: the ghost follows the cursor and
  // pointerup resolves the drop.
  const crossBoardWindowMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const crossBoardWindowUpRef = useRef<((e: PointerEvent) => void) | null>(null);
  const cleanupCrossBoardWindow = useCallback(() => {
    if (crossBoardWindowMoveRef.current) {
      window.removeEventListener("pointermove", crossBoardWindowMoveRef.current);
      crossBoardWindowMoveRef.current = null;
    }
    if (crossBoardWindowUpRef.current) {
      window.removeEventListener("pointerup", crossBoardWindowUpRef.current);
      crossBoardWindowUpRef.current = null;
    }
  }, []);
  const { board, breadcrumbs, viewport, viewportRevision, boardOpenRevision, error } = state;
  const notes = state.cards.filter((c): c is NoteCardDto => c.kind === "note");

  // Browser-style navigation history. Initialized lazily once Home is known.
  const historyRef = useRef<BoardHistory | null>(null);

  // Browser-like open-board tabs (session-only). Initialized lazily once Home is
  // known; the active tab always mirrors the currently loaded board.
  const [tabs, setTabs] = useState<BoardTabsState | null>(null);
  const tabsRef = useRef<BoardTabsState | null>(null);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Quick Boards: persisted, ordered references to Boards.
  const [quickBoards, setQuickBoards] = useState<QuickBoardDto[]>([]);
  const [quickBoardsCollapsed, setQuickBoardsCollapsed] = useState(false);

  // Serializes mutations (save/drag) so they never race on a card's revision.
  const queueRef = useRef(new MutationQueue());
  // Undo/redo over workspace commands (depends only on the stable gateway).
  const dispatcher = useMemo(() => new CommandDispatcher(gateway), [gateway]);
  // Always reflects the latest cards (notes AND portals) so queued tasks read
  // the current revision.
  const cardsRef = useRef(state.cards);
  useEffect(() => {
    cardsRef.current = state.cards;
  }, [state.cards]);

  const metadataInFlightRef = useRef(new Set<string>());
  const metadataAttemptedRef = useRef(new Set<string>());

  const requestEmbedMetadata = useCallback(
    (embed: EmbedCardDto, force = false) => {
      const attemptKey = `${embed.id}:${embed.revision}`;
      if (metadataInFlightRef.current.has(embed.id)) return;
      if (!force && metadataAttemptedRef.current.has(attemptKey)) return;

      metadataInFlightRef.current.add(embed.id);
      metadataAttemptedRef.current.add(attemptKey);
      void gateway
        .enrichEmbedMetadata({ id: embed.id, expectedRevision: embed.revision })
        .then((enriched) => {
          // Keep the mutation ref authoritative before the enriched card mounts:
          // Link Card may immediately persist a larger content-driven height.
          cardsRef.current = cardsRef.current.map((card) =>
            card.id === embed.id ? enriched : card,
          );
          dispatch({ type: "cardReplaced", id: embed.id, card: enriched });
        })
        .catch((cause) => {
          dispatch({ type: "failed", message: errorMessage(cause) });
        })
        .finally(() => {
          metadataInFlightRef.current.delete(embed.id);
        });
    },
    [gateway],
  );

  useEffect(() => {
    for (const card of state.cards) {
      if (card.kind === "embed" && card.metadataStatus === "pending") {
        requestEmbedMetadata(card);
      }
    }
  }, [requestEmbedMetadata, state.cards]);

  const handleRetryEmbedMetadata = useCallback(
    (id: string) => {
      const embed = cardsRef.current.find(
        (card): card is EmbedCardDto => card.kind === "embed" && card.id === id,
      );
      if (embed) requestEmbedMetadata(embed, true);
    },
    [requestEmbedMetadata],
  );

  // Screen->board coordinate converter, populated by CanvasAdapter on init.
  const screenToFlowRef = useRef<((x: number, y: number) => { x: number; y: number }) | null>(null);
  const boardRef = useRef(board);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  const viewportRevisionRef = useRef(viewportRevision);
  useEffect(() => {
    viewportRevisionRef.current = viewportRevision;
  }, [viewportRevision]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      dispatch({ type: "loading" });
      try {
        const home = await gateway.getHomeBoard();
        const snapshot = await gateway.loadBoardSnapshot(home.id);
        if (cancelled) return;
        historyRef.current = new BoardHistory(home.id);
        setTabs(
          createBoardTabs({
            boardId: snapshot.board.id,
            title: snapshot.board.title,
            colorToken: snapshot.board.colorToken,
            symbol: snapshot.board.symbol,
            coverAsset: snapshot.board.coverAsset,
          }),
        );
        dispatch({
          type: "snapshotLoaded",
          board: snapshot.board,
          breadcrumbs: snapshot.breadcrumbs,
          viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
          viewportRevision: snapshot.viewport.revision,
          cards: snapshot.cards.map((c) =>
            c.kind === "note"
              ? { ...c, documentJson: normalizeDocument(c.documentJson) }
              : c,
          ),
          unsortedCards: snapshot.unsortedCards.map((c) =>
            c.kind === "note"
              ? { ...c, documentJson: normalizeDocument(c.documentJson) }
              : c,
          ),
        });
      } catch (e) {
        if (!cancelled) {
          dispatch({ type: "failed", message: errorMessage(e) });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  // Load persisted Quick Board references once at startup.
  const loadQuickBoards = useCallback(() => {
    void gateway
      .listQuickBoards()
      .then(setQuickBoards)
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [gateway]);

  useEffect(() => {
    loadQuickBoards();
  }, [loadQuickBoards]);

  const handleCreateNote = useCallback(
    async (
      position?: { x: number; y: number },
      options?: { startEditing?: boolean },
    ) => {
      if (!board) return;
      const id = idGenerator.nextId();
      // An explicit position (double-click on the empty pane) places the note
      // exactly there; the rail/button path falls back to a cascading default.
      const x = position ? position.x : 40;
      const y = position ? position.y : 40 + notes.length * 24;
      const card: NoteCardDto = {
        kind: "note",
        id,
        boardId: board.id,
        frame: { x, y, width: 240, height: 120 },
        zIndex: notes.length,
        revision: 1,
        documentJson: plainTextToDocument(""),
        plainText: "",
      };
      try {
        await dispatcher.execute(
          new CreateNoteCommand(id, {
            id,
            boardId: board.id,
            frame: card.frame,
            zIndex: card.zIndex,
            documentJson: card.documentJson,
            plainText: "",
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
    [board, dispatcher, idGenerator, notes.length],
  );

  const handleCreateLink = useCallback(() => {
    void handleCreateNote(undefined, { startEditing: true });
  }, [handleCreateNote]);

  // Distribute one Unsorted card onto the canvas at a free cascading slot.
  const handlePlaceUnsortedCard = useCallback(
    (cardId: string) => {
      const card = state.unsortedCards.find((c) => c.id === cardId);
      if (!card || !board) return;
      const maxBottom = state.cards.reduce((max, c) => Math.max(max, c.frame.y + c.frame.height), 0);
      const frame = {
        x: 40,
        y: maxBottom > 0 ? maxBottom + 24 : 40,
        width: card.frame.width,
        height: card.frame.height,
      };
      void gateway
        .placeUnsortedCard({ id: cardId, expectedRevision: card.revision, frame })
        .then(() => {
          dispatch({
            type: "unsortedCardPlaced",
            id: cardId,
            frame,
            revision: card.revision + 1,
          });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [state.unsortedCards, state.cards, board, gateway],
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
        const card = state.unsortedCards.find((c) => c.id === id);
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
          .then(() => {
            dispatch({
              type: "unsortedCardPlaced",
              id,
              frame,
              revision: card.revision + 1,
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
    [state.unsortedCards, gateway, cleanupUnsortedDrag],
  );

  const handleCreateChildBoard = useCallback(async () => {
    if (!board) return;
    const boardId = idGenerator.nextId();
    const portalCardId = idGenerator.nextId();
    const portal: BoardPortalDto = {
      kind: "board_portal",
      id: portalCardId,
      boardId: board.id,
      frame: { x: 100, y: 100 + state.cards.length * 24, width: 120, height: 112 },
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
  }, [board, dispatcher, idGenerator, state.cards.length]);

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
        const card: ImageCardDto = {
          kind: "image",
          id: cardId,
          boardId: currentBoard.id,
          frame: { x, y, width: 320, height: 240 },
          zIndex: cardsRef.current.length,
          revision: 1,
          asset,
          captionJson: plainTextToDocument(""),
          captionPlainText: "",
        };
        await gateway.createImageCard({
          id: cardId,
          boardId: currentBoard.id,
          frame: card.frame,
          zIndex: card.zIndex,
          assetId,
          captionJson: card.captionJson,
          captionPlainText: "",
        });
        dispatch({ type: "cardAdded", card });
      } catch (e) {
        dispatch({ type: "failed", message: errorMessage(e) });
      }
    },
    [gateway, idGenerator],
  );

  const handleCreateImage = useCallback(async () => {
    const picked = await pickImageFile();
    if (!picked) return;
    await importImageCard(picked.path, picked.fileName, picked.mimeType, 80, 80 + cardsRef.current.length * 24);
  }, [importImageCard]);

  // Native drag-drop: import dropped image files at the current cursor position.
  useEffect(() => {
    return subscribeToImageDrops((files, x, y) => {
      const screenToFlow = screenToFlowRef.current;
      for (const file of files) {
        let flowX = 80;
        let flowY = 80 + cardsRef.current.length * 24;
        if (screenToFlow && Number.isFinite(x) && Number.isFinite(y)) {
          const flow = screenToFlow(x, y);
          if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
            flowX = flow.x;
            flowY = flow.y;
          }
        }
        // Center the new card under the cursor.
        void importImageCard(file.path, file.fileName, file.mimeType, flowX - 160, flowY - 120);
      }
    });
  }, [importImageCard]);

  const handleUpdateNote = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        // Defensive check before persisting: never write a non-object document
        // into SQLite. A structurally unusual (but still object) document is
        // preserved as-is — validation is protective, not a source of user-facing
        // save failures.
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const plainText = documentToPlainText(document);
        await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          plainText,
        });
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: note.revision + 1,
          documentJson: document,
          plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleFinalizeNote = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const note = cardsRef.current.find(
          (n): n is NoteCardDto => n.kind === "note" && n.id === id,
        );
        if (!note) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Note content is not a valid document");
        }

        const classification = classifyLinkConversion(document);
        if (classification.qualifies) {
          const embed = await gateway.convertNoteToEmbed({
            id,
            expectedRevision: note.revision,
            sourceUrl: classification.url,
            displayUrl: displayUrl(classification.url),
            title: classification.url,
            descriptionJson: plainTextToDocument(""),
            descriptionPlainText: "",
          });
          dispatch({ type: "cardReplaced", id, card: embed });
          return;
        }

        const plainText = documentToPlainText(document);
        await gateway.updateNote({
          id,
          expectedRevision: note.revision,
          documentJson: document,
          plainText,
        });
        dispatch({
          type: "cardContentUpdated",
          id,
          revision: note.revision + 1,
          documentJson: document,
          plainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleUpdateImageCaption = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const image = cardsRef.current.find(
          (c): c is ImageCardDto => c.kind === "image" && c.id === id,
        );
        if (!image) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Image caption is not a valid document");
        }
        const captionPlainText = documentToPlainText(document);
        await gateway.updateImageCaption({
          id,
          expectedRevision: image.revision,
          captionJson: document,
          captionPlainText,
        });
        dispatch({
          type: "imageCaptionUpdated",
          id,
          revision: image.revision + 1,
          captionJson: document,
          captionPlainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  const handleUpdateEmbedDescription = useCallback(
    (id: string, document: unknown): Promise<void> => {
      return queueRef.current.run(async () => {
        const embed = cardsRef.current.find(
          (c): c is EmbedCardDto => c.kind === "embed" && c.id === id,
        );
        if (!embed) return;
        if (typeof document !== "object" || document === null || (document as { type?: unknown }).type !== "doc") {
          throw new Error("Link description is not a valid document");
        }
        const descriptionPlainText = documentToPlainText(document);
        await gateway.updateEmbedDescription({
          id,
          expectedRevision: embed.revision,
          descriptionJson: document,
          descriptionPlainText,
        });
        dispatch({
          type: "embedDescriptionUpdated",
          id,
          revision: embed.revision + 1,
          descriptionJson: document,
          descriptionPlainText,
        });
      }).catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
        throw e;
      });
    },
    [gateway],
  );

  // Build the canvas projection from all cards (notes + portals).
  const canvasCards: CanvasCard[] = state.cards.map((c) => ({
    id: c.id,
    boardId: c.boardId,
    kind: c.kind,
    frame: c.frame,
    zIndex: c.zIndex,
    revision: c.revision,
    targetBoardId: c.kind === "board_portal" ? c.target.id : undefined,
    portalTitle: c.kind === "board_portal" ? c.target.title : undefined,
    portalCoverAssetId: c.kind === "board_portal" ? c.target.coverAsset?.id ?? undefined : undefined,
  }));

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
          await dispatcher.execute(
            new MoveCardsCommand(idGenerator.nextId(), moves),
          );

          for (const item of moves) {
            dispatch({
              type: "cardMoved",
              id: item.id,
              revision: item.revision + 1,
              frame: item.after,
            });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [idGenerator, dispatcher],
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
            dispatch({ type: "cardsRemoved", ids: [cardId] });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
        return;
      }

      // Blind drop of a leaf card into a board: it lands in that board's
      // Unsorted panel (Milanote-style) instead of stacking at the origin.
      void gateway
        .moveCardsToBoardUnsorted({
          targetBoardId,
          cards: [{ id: cardId, expectedRevision: card.revision }],
        })
        .then(() => {
          // If the target is the currently open board, show it in its Unsorted
          // panel; otherwise the card simply left this board (it will appear in
          // the target board's Unsorted when that board is opened).
          if (targetBoardId === boardRef.current?.id) {
            dispatch({ type: "cardMovedToUnsorted", id: cardId });
          } else {
            dispatch({ type: "cardsRemoved", ids: [cardId] });
          }
        })
        .catch((err) => {
          dispatch({ type: "failed", message: errorMessage(err) });
        });
    },
    [gateway, dispatcher, idGenerator],
  );

  // Quick Boards: remove deletes only the reference, and pin adds a reference
  // without moving/reparenting the Board. (Open lives after `navigateTo`.)
  const handleQuickBoardRemove = useCallback(
    (boardId: string) => {
      void gateway
        .removeQuickBoard(boardId)
        .then(loadQuickBoards)
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway, loadQuickBoards],
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
    [gateway, loadQuickBoards],
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
    [gateway, loadQuickBoards],
  );

  const handleDeleteSelection = useCallback(async () => {
    if (state.selection.length === 0) return;
    const items = state.selection
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind as "note" | "image" };
      })
      .filter((x): x is { id: string; kind: "note" | "image" | "board_portal" } => x !== null);

    if (items.length === 0) return;

    try {
      await dispatcher.execute(new TrashSelectionCommand(idGenerator.nextId(), items));
      dispatch({ type: "cardsRemoved", ids: state.selection });
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [state.selection, state.cards, dispatcher, idGenerator]);

  const viewportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleViewportChanged = useCallback(
    (e: { viewport: CanvasViewport }) => {
      // The board is pinned to its top-left origin; position is never persisted
      // (see the reducer's snapshotLoaded reset), only zoom is remembered.
      const settled: CanvasViewport = {
        x: 0,
        y: 0,
        zoom: e.viewport.zoom,
      };
      dispatch({ type: "viewportChanged", viewport: settled });
      if (viewportTimer.current) clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => {
        if (!board) return;
        void gateway
          .saveViewport({
            boardId: board.id,
            expectedRevision: viewportRevisionRef.current,
            x: settled.x,
            y: settled.y,
            zoom: settled.zoom,
          })
          .then(() => {
            dispatch({ type: "viewportSaved", revision: viewportRevisionRef.current + 1 });
          })
          .catch((err) => {
            dispatch({ type: "failed", message: errorMessage(err) });
          });
      }, 400);
    },
    [board, gateway],
  );

  const handleCardsSelected = useCallback((e: { ids: string[] }) => {
    const prev = state.selection;
    const next = e.ids;
    if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
      return;
    }
    dispatch({ type: "selectionChanged", ids: next });
  }, [state.selection]);

  const handleCardActivated = useCallback((id: string) => {
    const card = state.cards.find((c) => c.id === id);
    if (card?.kind === "note") {
      dispatch({ type: "editingStarted", id });
    }
  }, [state.cards]);

  const handleRequestContextMenu = useCallback(
    (cardId: string, x: number, y: number) => {
      // If the right-clicked card isn't part of the current selection, the menu
      // should act on just that card (and select it), matching Finder/Milanote.
      if (!state.selection.includes(cardId)) {
        dispatch({ type: "selectionChanged", ids: [cardId] });
      }
      setContextMenu({ cardId, x, y });
    },
    [state.selection],
  );

  const handleResizeNote = useCallback(
    (id: string, width: number, height: number) => {
      const card = cardsRef.current.find((c) => c.id === id);
      if (!card) return;
      void queueRef.current
        .run(async () => {
          const current = cardsRef.current.find((c) => c.id === id);
          if (!current) return;
          const frame = { ...current.frame, width, height };
          await gateway.moveCard({
            id,
            expectedRevision: current.revision,
            frame,
          });
          dispatch({ type: "cardMoved", id, revision: current.revision + 1, frame });
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [gateway],
  );

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    // Delete the current selection, not just the single right-clicked card. If
    // the selection is empty (e.g. cleared), fall back to the clicked card.
    const ids = state.selection.length > 0 ? state.selection : [contextMenu.cardId];
    setContextMenu(null);

    const items = ids
      .map((id) => {
        const card = state.cards.find((c) => c.id === id);
        if (!card) return null;
        if (card.kind === "board_portal") {
          return { id: card.target.id, kind: "board_portal" as const };
        }
        return { id: card.id, kind: card.kind as "note" | "image" };
      })
      .filter((x): x is { id: string; kind: "note" | "image" | "board_portal" } => x !== null);

    if (items.length === 0) return;
    void dispatcher
      .execute(new TrashSelectionCommand(idGenerator.nextId(), items))
      .then(() => dispatch({ type: "cardsRemoved", ids }))
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [contextMenu, state.selection, state.cards, dispatcher, idGenerator]);

  // Copy the stable MySpace address for the right-clicked card (or the current
  // board when invoked from a portal/board context). "Copy MySpace Link" is the
  // universal action; images additionally offer "Copy File Path".
  const handleCopyLink = useCallback(async () => {
    if (!contextMenu) return;
    const card = state.cards.find((c) => c.id === contextMenu.cardId);
    let address: string;
    if (card?.kind === "board_portal") {
      // A portal is a folder: copy the address of the board it leads to.
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
  }, [contextMenu, state.cards]);

  const handleCopyFilePath = useCallback(async () => {
    if (!contextMenu) return;
    const card = state.cards.find((c): c is ImageCardDto => c.kind === "image" && c.id === contextMenu.cardId);
    if (!card) return;
    try {
      const path = await gateway.resolveAssetPath(card.asset.id);
      await copyText(path);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [contextMenu, state.cards, gateway]);

  // Copy the stable address of the currently-open board.
  const handleCopyBoardLink = useCallback(async () => {
    setPaneContextMenu(null);
    if (!board) return;
    try {
      await copyText(`myspace://board/${board.id}`);
    } catch (e) {
      dispatch({ type: "failed", message: errorMessage(e) });
    }
  }, [board]);

  const handlePaneContextMenu = useCallback((x: number, y: number) => {
    setPaneContextMenu({ x, y });
  }, []);

  // Copy the images of the current selection to the system clipboard.
  const handleCopySelectionImages = useCallback(() => {
    const imageIds = state.selection.filter((id) => {
      const card = state.cards.find((c) => c.id === id);
      return card?.kind === "image";
    });
    if (imageIds.length === 0) return;
    void gateway
      .copyImageCards({ cardIds: imageIds })
      .catch((e) => {
        dispatch({ type: "failed", message: errorMessage(e) });
      });
  }, [state.selection, state.cards, gateway]);

  // Latest-wins navigation guard: a slow snapshot load must never overwrite a
  // newer navigation. Each call claims a monotonically increasing token before
  // awaiting; the snapshot is applied only if no newer call has started.
  const navigationTokenRef = useRef(0);

  // Load a board's snapshot into the store.
  const navigateTo = useCallback(
    async (
      boardId: string,
      opts?: { pushHistory?: boolean; tabMode?: "open" | "sync" },
    ) => {
      const token = ++navigationTokenRef.current;
      // Flush any pending note/viewport writes before replacing the projection,
      // so a debounced save cannot be abandoned by navigation (plan Section H).
      await queueRef.current.flush();
      if (navigationTokenRef.current !== token) return; // a newer navigation started
      const snapshot = await gateway.loadBoardSnapshot(boardId);
      if (navigationTokenRef.current !== token) return; // superseded while loading
      if (opts?.pushHistory && historyRef.current) {
        historyRef.current.push(boardId);
      }
      const tabMode = opts?.tabMode ?? "sync";
      // Track the board as an open tab: explicit navigation opens/activates a
      // tab; a reload just re-syncs the active id to the loaded board.
      setTabs((prev) => {
        const tab: BoardTab = {
          boardId: snapshot.board.id,
          title: snapshot.board.title,
          colorToken: snapshot.board.colorToken,
          symbol: snapshot.board.symbol,
          coverAsset: snapshot.board.coverAsset,
        };
        const base = prev ?? createBoardTabs(tab);
        const withHome = base.tabs.length === 0 ? createBoardTabs(tab) : base;
        const next = navigateBoardTab(withHome, tab, tabMode);
        return tabMode === "sync" ? activateBoardTab(next, snapshot.board.id) : next;
      });
      dispatch({
        type: "snapshotLoaded",
        board: snapshot.board,
        breadcrumbs: snapshot.breadcrumbs,
        viewport: { x: snapshot.viewport.x, y: snapshot.viewport.y, zoom: snapshot.viewport.zoom },
        viewportRevision: snapshot.viewport.revision,
        cards: snapshot.cards.map((c) =>
          c.kind === "note"
            ? { ...c, documentJson: normalizeDocument(c.documentJson) }
            : c,
        ),
        unsortedCards: snapshot.unsortedCards.map((c) =>
          c.kind === "note"
            ? { ...c, documentJson: normalizeDocument(c.documentJson) }
            : c,
        ),
      });
    },
    [gateway],
  );

  // During a card drag, resolve the board the pointer is over by hit-testing the
  // breadcrumb ancestor trail. Only the hovered board id is kept in state; the
  // actual drop is routed through handleCardDroppedOnPortal.
  const lastDraggedCardIdRef = useRef<string | null>(null);

  // Ref to the drag-end resolver so window pointer tracking (started after the
  // target board opens) can resolve the drop without ordering issues.
  const handleCardDragEndRef = useRef<(() => boolean) | null>(null);

  const startCrossBoardWindowTracking = useCallback(() => {
    cleanupCrossBoardWindow();
    const move = (e: PointerEvent) => {
      const drag = crossBoardDragRef.current;
      if (!drag) return;
      const pointerBoardId = boardRef.current?.id ?? null;
      setCrossBoardDrag((prev) =>
        prev ? moveCrossBoardDrag(prev, { x: e.clientX, y: e.clientY }, pointerBoardId) : prev,
      );
    };
    const up = () => {
      cleanupCrossBoardWindow();
      handleCardDragEndRef.current?.();
    };
    crossBoardWindowMoveRef.current = move;
    crossBoardWindowUpRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [cleanupCrossBoardWindow]);
  const handleCardDragMove = useCallback((e: { cardId: string; clientX: number; clientY: number }) => {
    lastDraggedCardIdRef.current = e.cardId;
    // Start a cross-board drag session on the first real move of a card. A
    // lingering finished/cancelled session (effect may resync ref from state)
    // must not block a new drag.
    const prev = crossBoardDragRef.current;
    if (!prev || prev.phase === "cancelled" || prev.phase === "committing") {
      const card = cardsRef.current.find((c) => c.id === e.cardId);
      if (card) {
        const drag = createCrossBoardDrag(
          [e.cardId],
          card.boardId,
          {
            cardId: card.id,
            kind: card.kind,
            width: card.frame.width,
            height: card.frame.height,
            label: card.kind === "note" ? card.plainText || "Note" : card.kind,
            revision: card.revision,
            boardId: card.boardId,
            frame: { ...card.frame },
          },
        );
        crossBoardDragRef.current = drag;
        setCrossBoardDrag(drag);
      }
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const crumbEl = el?.closest?.("[data-board-drop-id]") as HTMLElement | null;
    const boardId = crumbEl?.getAttribute("data-board-drop-id") ?? null;
    dropTargetBoardIdRef.current = boardId;
    setDropTargetBoardId(boardId);
    // Also hit-test the Quick Boards region so a Board Portal drop there pins a
    // reference instead of reparenting the Board.
    const quickEl = el?.closest?.("[data-quick-boards-drop]") as HTMLElement | null;
    const overQuick = Boolean(quickEl);
    overQuickBoardsRef.current = overQuick;
    setDropActiveQuickBoards(overQuick);

    // Cross-board: hit-test a Board tab. Hovering a tab for 600ms opens that
    // board so the drag can continue inside it (ghost follows the cursor).
    const tabEl = el?.closest?.("[data-testid='board-tab']") as HTMLElement | null;
    const tabBoardId = tabEl?.getAttribute("data-board-id") ?? null;
    const drag = crossBoardDragRef.current;
    if (drag) {
      // Track the board under the pointer (the currently open board's id).
      const pointerBoardId = boardRef.current?.id ?? null;
      setCrossBoardDrag((prev) =>
        prev ? moveCrossBoardDrag(prev, { x: e.clientX, y: e.clientY }, pointerBoardId) : prev,
      );
      if (tabBoardId && tabBoardId !== drag.sourceBoardId) {
        if (drag.hoverBoardId !== tabBoardId) {
          setCrossBoardDrag((prev) => (prev ? hoverCrossBoardTab(prev, tabBoardId) : prev));
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = setTimeout(() => {
            void navigateTo(tabBoardId, { tabMode: "open" }).then(() => {
              setCrossBoardDrag((prev) => (prev ? targetBoardLoaded(prev) : prev));
              // React Flow's drag stops after the snapshot swap; take over on
              // window so the ghost keeps following and pointerup resolves.
              startCrossBoardWindowTracking();
            });
          }, 600);
        }
      } else if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    }
  }, [navigateTo, startCrossBoardWindowTracking]);

  const handleCardDragEnd = useCallback((): boolean => {
    cleanupCrossBoardWindow();
    const cardId = lastDraggedCardIdRef.current;
    const targetBoardId = dropTargetBoardIdRef.current;
    const overQuick = overQuickBoardsRef.current;
    dropTargetBoardIdRef.current = null;
    overQuickBoardsRef.current = false;
    setDropTargetBoardId(null);
    setDropActiveQuickBoards(false);
    lastDraggedCardIdRef.current = null;

    // Cross-board drag: resolve the final drop. Only a drag that actually
    // reached the previewing phase (a tab was hovered and its board opened)
    // consumes the drop; otherwise fall through to the normal move path.
    const drag = crossBoardDragRef.current;
    if (drag) {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      const target = drag.hoverBoardId;
      const overTargetCanvas = drag.pointerBoardId === target;
      if (drag.phase === "previewing" && target && overTargetCanvas) {
        // Consume the session immediately so a duplicated drag-end call (React
        // Flow onNodeDragStop + our window pointerup) cannot commit twice.
        crossBoardDragRef.current = null;
        const gc = drag.ghostCard;
        if (gc) {
          const flow = screenToFlowRef.current;
          const point = flow
            ? flow(drag.pointer.x, drag.pointer.y)
            : { x: 40, y: 40 };
          const frame = {
            x: point.x - gc.width / 2,
            y: point.y - gc.height / 2,
            width: gc.width,
            height: gc.height,
          };
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
              setCrossBoardDrag(commitCrossBoardDrag(drag));
              crossBoardDragRef.current = null;
              // Reload the target board so the placed card appears immediately
              // (its snapshot was loaded before the move; the card now lives
              // there, so a plain cardsRemoved would wrongly hide it).
              void navigateTo(target, { tabMode: "sync" });
            })
            .catch((err) => {
              dispatch({ type: "failed", message: errorMessage(err) });
              setCrossBoardDrag(cancelCrossBoardDrag(drag));
              crossBoardDragRef.current = null;
            });
          return true; // consumed
        }
      }
      // Not consumed: clear the drag session and let the normal path run.
      setCrossBoardDrag(null);
      crossBoardDragRef.current = null;
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
      handleCardDroppedOnPortal(cardId, targetBoardId);
      return true; // consumed: moved to a portal
    }
    return false;
  }, [handleCardDroppedOnPortal, handleQuickBoardPin, gateway, dispatcher, idGenerator, navigateTo, cleanupCrossBoardWindow]);

  // Keep the drag-end resolver in a ref so window pointer tracking (started
  // after the target board opens) can resolve the drop.
  useEffect(() => {
    handleCardDragEndRef.current = handleCardDragEnd;
  }, [handleCardDragEnd]);

  // Reload the current board (no history push). Used to reconcile UI with the
  // database after undo/redo.
  const reloadCurrentBoard = useCallback(async () => {
    if (board) await navigateTo(board.id);
  }, [board, navigateTo]);

  const handleWorkspaceUndo = useCallback(async () => {
    try {
      if (await dispatcher.undo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard]);

  const handleWorkspaceRedo = useCallback(async () => {
    try {
      if (await dispatcher.redo()) await reloadCurrentBoard();
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error) });
    }
  }, [dispatcher, reloadCurrentBoard]);

  // Board cover actions: set from clipboard, choose a file, or remove. Each
  // updates the local portal projection immediately (cardReplaced) so the tile
  // re-renders without a full board reload.
  const handleSetCoverFromClipboard = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      const asset = await gateway.importClipboardImage();
      await gateway.setBoardCover({ boardId: portal.target.id, assetId: asset.id });
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: asset } },
      });
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
  }, [contextMenu, state.cards, gateway]);

  const handleChooseCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
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
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: asset } },
      });
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
  }, [contextMenu, state.cards, gateway, idGenerator]);

  const handleRemoveCover = useCallback(async () => {
    if (!contextMenu) return;
    const portal = state.cards.find(
      (c): c is BoardPortalDto => c.kind === "board_portal" && c.id === contextMenu.cardId,
    );
    if (!portal) return;
    try {
      await gateway.removeBoardCover(portal.target.id);
      dispatch({
        type: "cardReplaced",
        id: portal.id,
        card: { ...portal, target: { ...portal.target, coverAsset: null } },
      });
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
  }, [contextMenu, state.cards, gateway]);

  // Quick Boards: open navigates (opening/activating a tab).
  const handleQuickBoardOpen = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { pushHistory: true, tabMode: "open" });
    },
    [navigateTo],
  );

  // Detect external (agent) writes by polling SQLite's PRAGMA data_version. Any
  // commit from another connection changes it; then reload the open Board so the
  // UI reflects the external change without a manual refresh.
  const dataVersionRef = useRef<number>(0);
  useEffect(() => {
    let cancelled = false;
    // Prime the baseline once.
    void gateway.getDataVersion().then((v) => {
      if (!cancelled) dataVersionRef.current = v;
    });
    const id = setInterval(() => {
      void gateway.getDataVersion().then((v) => {
        if (!cancelled && v !== dataVersionRef.current && board) {
          dataVersionRef.current = v;
          void navigateTo(board.id);
        }
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gateway, board, navigateTo]);

  const handleRenameBoard = useCallback(
    (boardId: string, title: string) => {
      const card = state.cards.find(
        (c) => c.kind === "board_portal" && c.target.id === boardId,
      );
      const prevTitle = card?.kind === "board_portal" ? card.target.title : title;
      void dispatcher
        .execute(new RenameBoardCommand(idGenerator.nextId(), boardId, title, prevTitle))
        .then(() => {
          // Reload the board so portal titles + breadcrumbs reflect the new name.
          return reloadCurrentBoard();
        })
        .catch((e) => {
          dispatch({ type: "failed", message: errorMessage(e) });
        });
    },
    [state.cards, dispatcher, idGenerator, reloadCurrentBoard],
  );

  // Open a child board via a portal (double-click / Enter).
  const handleOpenBoard = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { pushHistory: true, tabMode: "open" });
    },
    [navigateTo],
  );

  // Double-click on a card: if it's a portal, open its target board (the
  // canvas passes the *card* id, so resolve to the target board first).
  const handleCardOpened = useCallback(
    (cardId: string) => {
      const card = state.cards.find((c) => c.id === cardId);
      if (card?.kind === "board_portal") {
        void navigateTo(card.target.id, { pushHistory: true, tabMode: "open" });
      }
    },
    [state.cards, navigateTo],
  );

  const handleNavigateBack = useCallback(() => {
    const prev = historyRef.current?.back();
    if (prev) void navigateTo(prev, { tabMode: "open" });
  }, [navigateTo]);

  const handleNavigateForward = useCallback(() => {
    const next = historyRef.current?.forward();
    if (next) void navigateTo(next, { tabMode: "open" });
  }, [navigateTo]);

  // Tab interactions: switching loads the board (no history push); closing
  // removes the tab and, if it was active, navigates to the neighbor.
  const handleTabActivate = useCallback(
    (boardId: string) => {
      void navigateTo(boardId, { tabMode: "sync" });
    },
    [navigateTo],
  );

  const handleTabClose = useCallback(
    (boardId: string) => {
      const prev = tabsRef.current;
      if (!prev) return;
      const next = closeBoardTab(prev, boardId);
      setTabs(next);
      if (next.activeBoardId !== prev.activeBoardId) {
        void navigateTo(next.activeBoardId, { tabMode: "sync" });
      }
    },
    [navigateTo],
  );

  const canvasRef = useRef<HTMLDivElement>(null);

  const handleEditDeactivate = useCallback(() => {
    dispatch({ type: "editingStopped" });
    // Return focus to the canvas so keyboard shortcuts (e.g. Cmd+A) and the
    // next interaction land back on the board, not a stale editor.
    canvasRef.current?.focus();
  }, []);

  // Cmd+[ / Cmd+] navigate back/forward, Cmd+Z / Cmd+Shift+Z undo/redo,
  // unless an editor owns focus.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inEditor = target && (target.tagName === "TEXTAREA" || target.isContentEditable);
      if (inEditor) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        void handleDeleteSelection();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        e.preventDefault();
        handleNavigateBack();
      } else if (e.key === "]") {
        e.preventDefault();
        handleNavigateForward();
      } else if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          void handleWorkspaceRedo();
        } else {
          void handleWorkspaceUndo();
        }
      } else if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        handleCopySelectionImages();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNavigateBack, handleNavigateForward, handleWorkspaceUndo, handleWorkspaceRedo, handleDeleteSelection, handleCopySelectionImages]);

  return (
    <AppShell
      topBar={
        <>
          <BoardBreadcrumbs
            breadcrumbs={breadcrumbs}
            currentBoardId={board?.id ?? ""}
            dropTargetBoardId={dropTargetBoardId}
            onNavigate={(id) => void navigateTo(id, { pushHistory: true, tabMode: "open" })}
          />
          <UndoRedoControls
            dispatcher={dispatcher}
            onUndo={handleWorkspaceUndo}
            onRedo={handleWorkspaceRedo}
          />
        </>
      }
      toolRail={
        <ToolRail
          onNewNote={() => void handleCreateNote()}
          onNewLink={handleCreateLink}
          onNewBoard={() => void handleCreateChildBoard()}
          onAddImage={() => void handleCreateImage()}
        />
      }
      rightRail={
        <QuickBoardsRail
          quickBoards={quickBoards}
          onOpen={handleQuickBoardOpen}
          onRemove={handleQuickBoardRemove}
          onReorder={handleQuickBoardsReorder}
          dropActive={dropActiveQuickBoards}
          collapsed={quickBoardsCollapsed}
          onToggleCollapsed={() => setQuickBoardsCollapsed((collapsed) => !collapsed)}
        />
      }
      rightRailCollapsed={quickBoardsCollapsed}
      unsortedRail={
        state.unsortedCards.length > 0 ? (
          <UnsortedPanel
            cards={state.unsortedCards}
            onPlace={handlePlaceUnsortedCard}
            onDragStartCard={handleUnsortedPointerDown}
          />
        ) : undefined
      }
    >
      <div className="workspace">
        {tabs && (
          <BoardTabs
            homeBoardId={tabs.homeBoardId}
            tabs={tabs.tabs}
            activeBoardId={tabs.activeBoardId}
            onActivate={handleTabActivate}
            onClose={handleTabClose}
          />
        )}
        {contextMenu && (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            data-testid="context-menu"
          >
            <button
              type="button"
              className="context-menu__item"
              onClick={() => {
                setContextMenu(null);
                void handleCopyLink();
              }}
            >
              Copy MySpace Link
            </button>
            {state.cards.find((c) => c.kind === "image" && c.id === contextMenu.cardId) && (
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  setContextMenu(null);
                  void handleCopyFilePath();
                }}
              >
                Copy File Path
              </button>
            )}
            {state.cards.find((c) => c.kind === "image" && c.id === contextMenu.cardId) && (
              <button
                type="button"
                className="context-menu__item"
                onClick={() => {
                  setContextMenu(null);
                  handleCopySelectionImages();
                }}
              >
                Copy Image
              </button>
            )}
            {state.cards.find((c) => c.kind === "board_portal" && c.id === contextMenu.cardId) && (
              <>
                <button
                  type="button"
                  className="context-menu__item"
                  onClick={() => {
                    setContextMenu(null);
                    void handleSetCoverFromClipboard();
                  }}
                >
                  Set Cover from Clipboard
                </button>
                <button
                  type="button"
                  className="context-menu__item"
                  onClick={() => {
                    setContextMenu(null);
                    void handleChooseCover();
                  }}
                >
                  Choose Cover…
                </button>
                {state.cards.find(
                  (c) =>
                    c.kind === "board_portal" &&
                    c.id === contextMenu.cardId &&
                    c.target.coverAsset !== null,
                ) && (
                  <button
                    type="button"
                    className="context-menu__item"
                    onClick={() => {
                      setContextMenu(null);
                      void handleRemoveCover();
                    }}
                  >
                    Remove Cover
                  </button>
                )}
              </>
            )}
            <button type="button" className="context-menu__item" onClick={handleContextDelete}>
              Delete
            </button>
          </div>
        )}
        {contextMenu && <div className="context-menu__backdrop" onClick={() => setContextMenu(null)} />}
        {paneContextMenu && (
          <div
            className="context-menu"
            style={{ left: paneContextMenu.x, top: paneContextMenu.y }}
            data-testid="pane-context-menu"
          >
            <button
              type="button"
              className="context-menu__item"
              onClick={() => void handleCopyBoardLink()}
            >
              Copy MySpace Link
            </button>
          </div>
        )}
        {paneContextMenu && (
          <div className="context-menu__backdrop" onClick={() => setPaneContextMenu(null)} />
        )}
        {error && (
          <CanvasErrorBanner
            message={error}
            onRetry={() => dispatch({ type: "clearError" })}
          />
        )}
        {crossBoardDrag?.phase === "previewing" && crossBoardDrag.ghostCard && (
          <div
            className="cross-board-ghost"
            data-testid="cross-board-ghost"
            style={{
              left: crossBoardDrag.pointer.x,
              top: crossBoardDrag.pointer.y,
              width: crossBoardDrag.ghostCard.width,
              height: crossBoardDrag.ghostCard.height,
            }}
          >
            {crossBoardDrag.ghostCard.label}
          </div>
        )}
        {unsortedGhost &&
          (() => {
            const card = state.unsortedCards.find((c) => c.id === unsortedGhost.cardId);
            if (!card) return null;
            return (
              <div
                className="cross-board-ghost"
                data-testid="unsorted-ghost"
                style={{
                  left: unsortedGhost.x,
                  top: unsortedGhost.y,
                  width: card.frame.width,
                  height: card.frame.height,
                }}
              >
                {card.kind === "note" ? card.plainText || "Note" : card.kind}
              </div>
            );
          })()}
        <div className="workspace__canvas" data-testid="canvas" ref={canvasRef}>
          <CanvasAdapter
            cards={canvasCards}
            viewport={viewport}
            viewportResetToken={boardOpenRevision}
            editingCardId={state.editingCardId}
            onScreenToFlowReady={(fn) => {
              screenToFlowRef.current = fn;
            }}
            events={{
              onCardsMoved: handleCardsMoved,
              onViewportChanged: handleViewportChanged,
              onSelectionChanged: handleCardsSelected,
              onCardActivated: handleCardActivated,
              onCardOpened: handleCardOpened,
              onCardContextMenu: handleRequestContextMenu,
              onPaneContextMenu: handlePaneContextMenu,
              onCardDroppedOnPortal: handleCardDroppedOnPortal,
              onPortalHighlight: setHighlightedPortalId,
              onCardDragMove: handleCardDragMove,
              onCardDragEnd: handleCardDragEnd,
              onPaneDoubleClick: (point) => {
                void handleCreateNote(point);
              },
            }}
            renderCard={(card) => {
              const full = state.cards.find((c) => c.id === card.id);
              if (!full) return null;
              return renderCardFromRegistry(full, {
                editing: state.editingCardId === full.id,
                onDeactivate: handleEditDeactivate,
                onUpdateNote: handleUpdateNote,
                onFinalizeNote: handleFinalizeNote,
                onUpdateImageCaption: handleUpdateImageCaption,
                onUpdateEmbedDescription: handleUpdateEmbedDescription,
                onRetryEmbedMetadata: handleRetryEmbedMetadata,
                onOpenBoard: handleOpenBoard,
                onRenameBoard: handleRenameBoard,
                onContextMenu: handleRequestContextMenu,
                onResizeNote: handleResizeNote,
                onResizeImage: handleResizeNote,
                onResizeEmbed: handleResizeNote,
                highlightedPortalId,
              });
            }}
          />
          {notes.length === 0 && !error && (
            <div className="workspace__empty">
              Click “New note” to create your first note.
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default App;

/** A short, human-friendly URL for display (strips scheme and trailing slash). */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return raw;
  }
}
