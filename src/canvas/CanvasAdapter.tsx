import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";

import { CanvasScrollbars } from "./CanvasScrollbars";
import { cardToNodeLike, frameIntersectionRatio, movedNodeToCard, staleNodeIds } from "./canvas-mapping";
import type {
  CanvasCard,
  CanvasEvents,
  CanvasViewport,
} from "./canvas-types";

interface CanvasAdapterProps {
  cards: CanvasCard[];
  viewport: CanvasViewport;
  viewportResetToken?: number;
  events: CanvasEvents;
  /** Renders the interior of a card given its domain card. */
  renderCard: (card: CanvasCard) => ReactNode;
  /** The id of the card currently being edited, if any (forces node rebuild). */
  editingCardId?: string | null;
  /** Exposes a screen->board coordinate converter (used for file drops). */
  onScreenToFlowReady?: (fn: (x: number, y: number) => { x: number; y: number }) => void;
  /** Imperative focus request: center + select a card after a board loads. */
  focusRequest?: { cardId: string; token: number } | null;
  /** Transient search phrase, used only to force card re-render for highlight. */
  highlightQuery?: string;
}

/**
 * True for targets where Space must type a space (or press a control), never
 * start Space-pan: text fields, contenteditable (the Tiptap editor), and
 * React Flow's own `.nokey` opt-out.
 */
function isSpaceReservedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('[contenteditable]:not([contenteditable="false"]), .ProseMirror, .nokey')) return true;
  // Space activates a focused button/link — leave that alone.
  return !!target.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="option"]');
}

type CardNodeData = { content: ReactNode; kind: CanvasCard["kind"] };

/** Top-left of the translate extent: the board never scrolls above/left of its origin. */
const TRANSLATE_EXTENT_MIN = { x: 0, y: 0 } as const;

const nodeTypes: NodeTypes = {
  // Раньше рамка была принудительно 100%/100% от React Flow узла, чей
  // width/height берётся из card.frame (сохранённого, обновляется только
  // по коммиту resize). Каждая resizable-карточка уже держит свой live
  // размер на собственном корне (стиль width/height от локального draft-
  // состояния во время drag) — рамка должна брать размер у контента, а не
  // навязывать свой, иначе во время drag виден «призрак» старой рамки
  // вокруг уже сжавшегося содержимого (tasks/lessons.md 2026-09-18).
  card: ({ data, selected }: { data: CardNodeData; selected?: boolean }) => (
    <div
      className="canvas-card-frame"
      data-card-kind={data.kind}
      data-selected={selected ? "true" : undefined}
    >
      {data.content}
    </div>
  ),
};

function cardToNode(card: CanvasCard, renderCard: (c: CanvasCard) => ReactNode): Node<CardNodeData> {
  const like = cardToNodeLike(card);
  return {
    id: like.id,
    type: "card",
    position: like.position,
    width: like.width,
    height: like.height,
    zIndex: like.zIndex,
    data: { content: renderCard(card), kind: card.kind },
    // No per-node `draggable`: an explicit `true` here would override the
    // `nodesDraggable={false}` that Space-pan mode sets (React Flow gives the
    // node's own flag precedence), and a draggable node carries `nopan`, so a
    // Space+drag starting over a card would move the card instead of panning.
  };
}

/**
 * The single place React Flow is used (ADR-002). It maps domain cards to
 * renderer nodes and reports only application-owned events back out.
 */
export function CanvasAdapter({
  cards,
  viewport,
  viewportResetToken = 0,
  events,
  renderCard,
  editingCardId = null,
  onScreenToFlowReady,
  focusRequest = null,
  highlightQuery = "",
}: CanvasAdapterProps) {
  const flowRef = useRef<{
    setViewport: (viewport: CanvasViewport) => void;
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number };
    setCenter: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
    getZoom: () => number;
  } | null>(null);
  const viewportRef = useRef(viewport);
  // The interaction-reset remount below (todo.md №26) must restore the pan the
  // user was actually looking at, not the `viewport` *prop* — that prop is
  // pinned to `{x: 0, y: 0}` by every `onMoveEnd` (ADR-0003: pan is never
  // persisted, only zoom), so by the time any scroll gesture has settled even
  // once, `viewport` itself is already stale-zero. Feeding that into
  // `defaultViewport` on remount is exactly what produced the "spring back to
  // the top" bug: a `key={interactionResetRevision}` remount (see
  // `resetInterruptedMarquee` below) re-mounted React Flow with
  // `defaultViewport={viewport}`, which had already been zeroed by the most
  // recent scroll settle. `liveViewport` (state, so it's safe to read during
  // render — a ref is not) tracks the real, continuously updated pan/zoom
  // instead, independent of what gets persisted; `liveViewportRef` mirrors it
  // for the `onInit` handler, which runs outside render.
  const [liveViewport, setLiveViewport] = useState(viewport);
  const liveViewportRef = useRef(viewport);
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>(() =>
    cards.map((c) => cardToNode(c, renderCard)),
  );
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [interactionResetRevision, setInteractionResetRevision] = useState(0);

  // Space + left-drag pans (Milanote). React Flow's own `panActivationKeyCode`
  // is not enough: it switches `panOnDrag` on, but every draggable node carries
  // `nopan`, so dragging over a card with Space held still moved the card. While
  // Space is held we therefore also turn node dragging and marquee selection
  // off; see the ReactFlow props below.
  const [spacePan, setSpacePan] = useState(false);
  useEffect(() => {
    const isSpace = (event: KeyboardEvent) => event.code === "Space" || event.key === " ";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSpace(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isSpaceReservedTarget(event.target) || isSpaceReservedTarget(document.activeElement)) return;
      event.preventDefault();
      setSpacePan(true);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (isSpace(event)) setSpacePan(false);
    };
    const release = () => setSpacePan(false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  // React Flow 12 очищает рамку по pointerup, но оставляет её при pointercancel.
  // WKWebView также может потерять pointerup, когда жест выходит за границы окна.
  // Перемонтируем канвас только при реально зависшей рамке, не затрагивая обычные жесты.
  const resetInterruptedMarquee = useCallback(() => {
    if (!surfaceRef.current?.querySelector(".react-flow__selection")) return;
    // Sync the render-safe `liveViewport` state from the ref right before the
    // remount below reads it as `defaultViewport` — todo.md №26: this must be
    // the pan the user actually had, not stale render-time state.
    setLiveViewport(liveViewportRef.current);
    setInteractionResetRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") resetInterruptedMarquee();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") resetInterruptedMarquee();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    window.addEventListener("blur", resetInterruptedMarquee);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
      window.removeEventListener("blur", resetInterruptedMarquee);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [resetInterruptedMarquee]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // Rebuild nodes when the projection changes, using React's "adjust state
  // during render" pattern — but only the nodes whose own inputs changed
  // (P1.8). This used to be keyed on one O(N) string of every card's frame and
  // revision, and any change to it rebuilt *every* node, so editing one note on
  // a 1 000-card board re-created 1 000 node objects and re-rendered 1 000
  // cards. Now each node is rebuilt only when its card's projection inputs
  // (`canvasNodeInputsEqual`: id, kind, frame, zIndex, revision, portal
  // appearance), its editing flag or the highlight query changed; every other
  // node keeps its previous object — including React Flow's own state on it
  // (selection, measured size) — so React Flow skips it and its memoised card
  // component is never called. A rebuilt node preserves its `selected` flag, so
  // entering/leaving edit mode or a sibling save never drops the selection.
  const [built, setBuilt] = useState({ cards, editingCardId, highlightQuery });

  if (
    cards !== built.cards ||
    editingCardId !== built.editingCardId ||
    highlightQuery !== built.highlightQuery
  ) {
    const stale = staleNodeIds(built, { cards, editingCardId, highlightQuery });
    setBuilt({ cards, editingCardId, highlightQuery });
    if (stale !== null) {
      setNodes((prev) => {
        const prevById = new Map(prev.map((n) => [n.id, n]));
        let changed = prev.length !== cards.length;
        const next = cards.map((c, i) => {
          const existing = prevById.get(c.id);
          if (existing && !stale.has(c.id)) {
            if (prev[i] !== existing) changed = true;
            return existing;
          }
          changed = true;
          const node = cardToNode(c, renderCard);
          node.selected = existing?.selected ?? false;
          return node;
        });
        return changed ? next : prev;
      });
    }
  }

  const nodesRef = useRef(nodes);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const highlightedPortalRef = useRef<string | null>(null);
  const lastPaneClickRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const paneClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Dragging a node near the canvas top clamps the node at the board origin, so
  // React Flow stops emitting `onNodeDrag` pointer coordinates before the pointer
  // can reach the header breadcrumbs. To keep cross-surface drop targets
  // (breadcrumbs) working, we track the raw pointer on `window` for the duration
  // of the drag and report those screen coords instead.
  const windowDragMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const windowDragUpRef = useRef<(() => void) | null>(null);
  const draggingCardIdRef = useRef<string | null>(null);

  const cleanupWindowDragListeners = () => {
    if (windowDragMoveRef.current) {
      window.removeEventListener("pointermove", windowDragMoveRef.current);
      windowDragMoveRef.current = null;
    }
    if (windowDragUpRef.current) {
      window.removeEventListener("pointerup", windowDragUpRef.current);
      windowDragUpRef.current = null;
    }
  };

  useEffect(() => cleanupWindowDragListeners, []);

  // Double-click window for the empty pane. React Flow v12 exposes only
  // `onPaneClick`; we fold two rapid clicks into a single `onPaneDoubleClick`.
  const DOUBLE_CLICK_MS = 300;

  const handlePaneClick = (event: React.MouseEvent) => {
    const flow = flowRef.current;
    if (!flow) return;
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const now = Date.now();
    const last = lastPaneClickRef.current;

    if (last && now - last.t <= DOUBLE_CLICK_MS) {
      if (paneClickTimerRef.current) {
        clearTimeout(paneClickTimerRef.current);
        paneClickTimerRef.current = null;
      }
      lastPaneClickRef.current = null;
      events.onPaneDoubleClick?.({ x: point.x, y: point.y }, { x: event.clientX, y: event.clientY });
      return;
    }

    lastPaneClickRef.current = { x: point.x, y: point.y, t: now };
    if (paneClickTimerRef.current) clearTimeout(paneClickTimerRef.current);
    // If the second click never comes, let the first expire by forgetting it.
    paneClickTimerRef.current = setTimeout(() => {
      lastPaneClickRef.current = null;
    }, DOUBLE_CLICK_MS);
  };

  const handlePaneContextMenu = (event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    events.onPaneContextMenu?.(event.clientX, event.clientY);
  };

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    // Доска всегда открывается от (0,0). `defaultViewport` работает только на
    // первом mount, поэтому при каждом открытии/перезаходе в доску viewport
    // нужно переустанавливать императивно.
    flowRef.current?.setViewport(viewportRef.current);
    // A genuine board switch is the one case where snapping back to (0,0) is
    // correct (ADR-0003) — keep the interaction-reset remount's baseline in
    // sync so it doesn't restore a pan from the board just left.
    liveViewportRef.current = viewportRef.current;
    setLiveViewport(viewportRef.current);
  }, [viewportResetToken]);

  // Imperative focus: when the parent requests a card (e.g. a search result),
  // center the viewport on it and mark it selected. Waits for the node to exist
  // (the board may still be loading), and applies once per request token.
  const lastAppliedFocusTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    if (lastAppliedFocusTokenRef.current === focusRequest.token) return;
    const flow = flowRef.current;
    const node = nodesRef.current.find((n) => n.id === focusRequest.cardId);
    if (!flow || !node) return;

    lastAppliedFocusTokenRef.current = focusRequest.token;
    const cx = node.position.x + (node.width ?? 0) / 2;
    const cy = node.position.y + (node.height ?? 0) / 2;
    flow.setCenter(cx, cy, { zoom: flow.getZoom(), duration: 0 });
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === focusRequest.cardId })));
    events.onSelectionChanged?.({ ids: [focusRequest.cardId] });
  }, [focusRequest, nodes, events]);

  // Resolves the portal a drag/drop should target. The CURSOR wins first: a
  // portal whose frame contains the pointer's board-space position is the
  // target the user is actually looking at, regardless of how much of the
  // dragged card's own frame happens to overlap a neighbouring portal. Before
  // this, the target was picked purely by frame-overlap ratio (see
  // tasks/lessons.md 2026-09-08), so a large card dragged toward portal A
  // would drop onto portal B instead whenever B's edge caught more of the
  // card's rectangle than A did — even with the pointer sitting squarely over
  // A (todo.md №22). Overlap is now only a FALLBACK for when the cursor is
  // not over any portal at all (e.g. a big card whose body still meaningfully
  // covers a portal even though the pointer let go just outside its frame).
  // Several portals can overlap each other; among cursor hits, the top one
  // (highest zIndex) wins. A board_portal source may target OTHER portals
  // (Board-on-Board), never itself.
  const PORTAL_DROP_THRESHOLD = 0.25;
  const portalAtPoint = (
    node: Node<CardNodeData>,
    cursor: { x: number; y: number } | null,
  ): CanvasCard | null => {
    const source = cards.find((c) => c.id === node.id);
    if (!source) return null;

    if (cursor) {
      let cursorHit: CanvasCard | null = null;
      let bestZ = -Infinity;
      for (const c of cards) {
        if (c.kind !== "board_portal" || !c.targetBoardId) continue;
        if (c.id === source.id) continue; // never drop onto itself
        const { frame } = c;
        const inside =
          cursor.x >= frame.x &&
          cursor.x <= frame.x + frame.width &&
          cursor.y >= frame.y &&
          cursor.y <= frame.y + frame.height;
        if (inside && c.zIndex > bestZ) {
          bestZ = c.zIndex;
          cursorHit = c;
        }
      }
      if (cursorHit) return cursorHit;
    }

    const rect = {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? source.frame.width,
      height: node.height ?? source.frame.height,
    };

    let best: CanvasCard | null = null;
    let bestRatio = 0;
    for (const c of cards) {
      if (c.kind !== "board_portal" || !c.targetBoardId) continue;
      if (c.id === source.id) continue; // never drop onto itself
      const ratio = frameIntersectionRatio(rect, c.frame);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = c;
      }
    }
    return bestRatio >= PORTAL_DROP_THRESHOLD ? best : null;
  };

  // Converts a drag event's screen-space pointer into a board-space point,
  // when the event carries client coordinates (mouse events do; some
  // synthetic/touch paths may not).
  const cursorFlowPoint = (
    event: React.MouseEvent | MouseEvent | TouchEvent | undefined,
  ): { x: number; y: number } | null => {
    if (!event || !("clientX" in event)) return null;
    return flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? null;
  };

  const handleNodesChange = (changes: NodeChange<Node<CardNodeData>>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev) as Node<CardNodeData>[]);
  };

  const handleSelectionChange = (params: OnSelectionChangeParams) => {
    const ids = params.nodes.map((n) => n.id);
    selectedIdsRef.current = new Set(ids);
    events.onSelectionChanged?.({ ids });
  };

  const handleNodeDragStop = (
    event: React.MouseEvent | MouseEvent | TouchEvent | undefined,
    node: Node<CardNodeData> | undefined,
  ) => {
    // The drag session owns the dragged card id. A cross-board drop replaces the
    // board snapshot, so the React Flow node can already be gone when drag-stop
    // fires; `node` is then absent and must never be dereferenced.
    const draggedCardId = draggingCardIdRef.current ?? node?.id ?? null;
    // Board-space cursor position at release, used to resolve the portal drop
    // target by where the pointer actually is (see `portalAtPoint`).
    const cursorPoint = cursorFlowPoint(event);
    const selected = selectedIdsRef.current;
    const ids =
      draggedCardId !== null && selected.has(draggedCardId) && selected.size > 1
        ? [...selected]
        : draggedCardId !== null
          ? [draggedCardId]
          : [];

    // Stop the raw-pointer tracking opened at drag start.
    cleanupWindowDragListeners();
    draggingCardIdRef.current = null;

    // Clear any portal highlight.
    if (highlightedPortalRef.current !== null) {
      highlightedPortalRef.current = null;
      events.onPortalHighlight?.(null);
    }
    // Clear any transient breadcrumb drop-target highlight. This resolves the
    // drop from `dropTargetBoardIdRef` set by the last window pointermove, which
    // already runs before React Flow's drag-stop callback. If the drop was
    // consumed (pinned to Quick Boards / moved to a portal), stop here and do
    // not also persist a plain reposition.
    if (events.onCardDragEnd?.()) {
      return;
    }

    // No card id means the node was taken away by a snapshot replacement: the
    // drag is over, cleanup above already ran, and nothing is left to persist.
    if (ids.length === 0) return;

    // Drop onto a portal: if the dragged card (or group) lands inside a board
    // portal, move the whole selection there instead of repositioning.
    const dragged = nodesRef.current.find((n) => n.id === ids[0]);
    if (dragged) {
      const portal = portalAtPoint(dragged, cursorPoint);
      if (portal?.targetBoardId) {
        events.onCardsDroppedOnPortal?.(ids, portal.targetBoardId);
        return;
      }
    }

    const moved = ids.map((id) => {
      const movedNode = nodesRef.current.find((n) => n.id === id);
      const source = cards.find((c) => c.id === id);
      if (!movedNode || !source) return null;
      const card = movedNodeToCard(
        {
          id: movedNode.id,
          position: movedNode.position,
          width: movedNode.width ?? source.frame.width,
          height: movedNode.height ?? source.frame.height,
          zIndex: source.zIndex,
        },
        source,
      );
      return { id: card.id, frame: card.frame };
    });

    const valid = moved.filter((m): m is { id: string; frame: CanvasCard["frame"] } => m !== null);
    if (valid.length > 0) {
      events.onCardsMoved?.({ cards: valid });
    }
  };

  const handleNodeClick = (
    event: React.MouseEvent,
    node: Node<CardNodeData>,
  ) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      return;
    }
    events.onCardActivated?.(node.id);
  };

  // During drag, report which portal (if any) the card is over, so the parent
  // can highlight it. Only emit on change to avoid redundant renders. Also
  // surface the screen-space pointer so the parent can hit-test breadcrumbs.
  const handleNodeDrag = (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node<CardNodeData>) => {
    // The hover highlight must resolve the same way the eventual drop will
    // (cursor-first, overlap fallback) — otherwise the highlighted portal
    // would lie about where the card is about to land.
    const portal = portalAtPoint(node, cursorFlowPoint(event));
    const portalId = portal?.id ?? null;
    if (portalId !== highlightedPortalRef.current) {
      highlightedPortalRef.current = portalId;
      events.onPortalHighlight?.(portalId);
    }
    if ("clientX" in event) {
      events.onCardDragMove?.({
        cardId: node.id,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    }
  };

  // Begin a node drag. Also start tracking the raw pointer on `window` so that
  // drop targets OUTSIDE the pane (breadcrumbs in the header) keep receiving
  // accurate screen coordinates throughout the gesture, even after the node is
  // clamped at the board origin.
  const handleNodeDragStart = (event: React.MouseEvent | MouseEvent | TouchEvent, node: Node<CardNodeData>) => {
    draggingCardIdRef.current = node.id;

    const report = (e: PointerEvent) => {
      const cardId = draggingCardIdRef.current;
      if (!cardId) return;
      events.onCardDragMove?.({
        cardId,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    };
    const stop = () => cleanupWindowDragListeners();

    windowDragMoveRef.current = report;
    windowDragUpRef.current = stop;
    window.addEventListener("pointermove", report);
    window.addEventListener("pointerup", stop);

    // Seed the first position from the initiating event.
    if ("clientX" in event) {
      events.onCardDragMove?.({ cardId: node.id, clientX: event.clientX, clientY: event.clientY });
    }
  };

  const handleNodeDoubleClick = (
    _: React.MouseEvent,
    node: Node<CardNodeData>,
  ) => {
    events.onCardOpened?.(node.id);
  };

  const handleNodeContextMenu = (
    event: React.MouseEvent,
    node: Node<CardNodeData>,
  ) => {
    event.preventDefault();
    events.onCardContextMenu?.(node.id, event.clientX, event.clientY);
  };

  // Right-click on the selection overlay (marquee selected nodes): the event
  // carries the selected nodes, but our app already tracks `selection`, so we
  // just surface the menu at the pointer using an arbitrary selected id.
  const handleSelectionContextMenu = (
    event: React.MouseEvent,
    nodes: Node<CardNodeData>[],
  ) => {
    event.preventDefault();
    if (nodes.length === 0) return;
    events.onCardContextMenu?.(nodes[0].id, event.clientX, event.clientY);
  };

  const handleMoveEnd = (_: unknown, vp: { x: number; y: number; zoom: number }) => {
    // The real, current pan — kept separate from `onViewportChanged` below,
    // whose caller pins x/y to 0 before persisting (ADR-0003). Only this ref
    // may ever hold the live position.
    liveViewportRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom };
    events.onViewportChanged?.({ viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } });
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      const target = e.target as HTMLElement;
      const isEditing = target.tagName === "TEXTAREA" || target.isContentEditable;
      if (!isEditing) {
        e.preventDefault();
        const allIds = cards.map((c) => c.id);
        selectedIdsRef.current = new Set(allIds);
        setNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
        events.onSelectionChanged?.({ ids: allIds });
      }
    }
  };

  return (
    <div
      ref={surfaceRef}
      className={spacePan ? "canvas-surface canvas-surface--space-pan" : "canvas-surface"}
      data-testid="canvas-surface"
      data-space-pan={spacePan ? "true" : undefined}
      data-kind="desk"
      tabIndex={0}
      onKeyDown={handleCanvasKeyDown}
      onPointerCancel={resetInterruptedMarquee}
      style={{ width: "100%", height: "100%" }}
    >
      <ReactFlow
        key={interactionResetRevision}
        nodes={nodes}
        nodeTypes={nodeTypes}
        // P1.8: mount only the cards that intersect the viewport. React Flow
        // still renders every node once (to measure it), then unmounts the
        // off-screen ones; marquee selection, select-all and group drag work
        // from its internal node lookup (positions + our explicit width/height),
        // not the DOM, so off-screen selected cards still move with the group.
        onlyRenderVisibleElements
        onNodesChange={handleNodesChange}
        deleteKeyCode={null}
        defaultViewport={liveViewport}
        translateExtent={[[TRANSLATE_EXTENT_MIN.x, TRANSLATE_EXTENT_MIN.y], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]}
        nodeExtent={[[0, 0], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]}
        panOnScroll
        // Space-pan is handled above (it also has to disable node dragging),
        // so React Flow's built-in Space activation is switched off.
        panActivationKeyCode={null}
        selectionOnDrag={!spacePan}
        panOnDrag={spacePan ? [0, 1, 2] : [1, 2]}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        nodesDraggable={!spacePan}
        nodesConnectable={false}
        edgesFocusable={false}
        nodesFocusable
        elementsSelectable
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        onSelectionChange={handleSelectionChange}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionContextMenu={handleSelectionContextMenu}
        onNodeDrag={handleNodeDrag}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
        onInit={(instance) => {
          flowRef.current = instance;
          // `liveViewportRef`, not `viewportRef`: this also runs on the
          // interaction-reset remount (todo.md №26), where the board hasn't
          // changed and the live pan must survive. `viewportRef` (the
          // ADR-0003-pinned, board-open value) is applied separately by the
          // `viewportResetToken` effect above for genuine board switches.
          instance.setViewport(liveViewportRef.current);
          onScreenToFlowReady?.((x, y) => instance.screenToFlowPosition({ x, y }));
        }}
        minZoom={0.1}
        maxZoom={4}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={3} color="var(--desk-dot)" />
        <CanvasScrollbars extentMin={TRANSLATE_EXTENT_MIN} />
      </ReactFlow>
    </div>
  );
}
