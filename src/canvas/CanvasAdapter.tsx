import { useEffect, useRef, useState, type ReactNode } from "react";
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

import { cardToNodeLike, movedNodeToCard } from "./canvas-mapping";
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
}

type CardNodeData = { content: ReactNode };

const nodeTypes: NodeTypes = {
  card: ({ data }: { data: CardNodeData }) => (
    <div style={{ width: "100%", height: "100%" }}>{data.content}</div>
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
    data: { content: renderCard(card) },
    draggable: true,
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
}: CanvasAdapterProps) {
  const flowRef = useRef<{
    setViewport: (viewport: CanvasViewport) => void;
    screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number };
  } | null>(null);
  const viewportRef = useRef(viewport);
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>(() =>
    cards.map((c) => cardToNode(c, renderCard)),
  );

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  // Rebuild nodes when the projection (frames OR revision OR editing focus)
  // changes, using React's "adjust state during render" pattern. Preserve each
  // node's `selected` flag across the rebuild so entering/leaving edit mode (or
  // a sibling save) does not silently drop the user's selection.
  const cardsKey =
    cards
      .map((c) => `${c.id}:${c.frame.x},${c.frame.y},${c.frame.width},${c.frame.height},${c.zIndex},${c.revision}`)
      .join("|") + `#edit:${editingCardId ?? ""}`;
  const [lastKey, setLastKey] = useState(cardsKey);

  if (cardsKey !== lastKey) {
    setLastKey(cardsKey);
    setNodes((prev) => {
      const selectedById = new Map(prev.map((n) => [n.id, n.selected]));
      return cards.map((c) => {
        const node = cardToNode(c, renderCard);
        node.selected = selectedById.get(c.id) ?? false;
        return node;
      });
    });
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
      events.onPaneDoubleClick?.({ x: point.x, y: point.y });
      return;
    }

    lastPaneClickRef.current = { x: point.x, y: point.y, t: now };
    if (paneClickTimerRef.current) clearTimeout(paneClickTimerRef.current);
    // If the second click never comes, let the first expire by forgetting it.
    paneClickTimerRef.current = setTimeout(() => {
      lastPaneClickRef.current = null;
    }, DOUBLE_CLICK_MS);
  };

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    // Доска всегда открывается от (0,0). `defaultViewport` работает только на
    // первом mount, поэтому при каждом открытии/перезаходе в доску viewport
    // нужно переустанавливать императивно.
    flowRef.current?.setViewport(viewportRef.current);
  }, [viewportResetToken]);

  // Returns the portal card whose bounds contain the given card's center, or null.
  // A board_portal source may now target OTHER portals (Board-on-Board), but never
  // itself.
  const portalAtPoint = (node: Node<CardNodeData>): CanvasCard | null => {
    const source = cards.find((c) => c.id === node.id);
    if (!source) return null;
    const cx = node.position.x + (node.width ?? source.frame.width) / 2;
    const cy = node.position.y + (node.height ?? source.frame.height) / 2;
    return (
      cards.find((c) => {
        if (c.kind !== "board_portal" || !c.targetBoardId) return false;
        if (c.id === source.id) return false; // never drop onto itself
        return (
          cx >= c.frame.x &&
          cx <= c.frame.x + c.frame.width &&
          cy >= c.frame.y &&
          cy <= c.frame.y + c.frame.height
        );
      }) ?? null
    );
  };

  const handleNodesChange = (changes: NodeChange<Node<CardNodeData>>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev) as Node<CardNodeData>[]);
  };

  const handleSelectionChange = (params: OnSelectionChangeParams) => {
    const ids = params.nodes.map((n) => n.id);
    selectedIdsRef.current = new Set(ids);
    events.onSelectionChanged?.({ ids });
  };

  const handleNodeDragStop = (_: unknown, node: Node<CardNodeData>) => {
    const selected = selectedIdsRef.current;
    const ids = selected.has(node.id) && selected.size > 1 ? [...selected] : [node.id];

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
    // already runs before React Flow's drag-stop callback.
    events.onCardDragEnd?.();

    // Drop onto a portal: if a single card's center lands inside a board portal,
    // move it to that board instead of repositioning on the current board.
    if (ids.length === 1) {
      const dragged = nodesRef.current.find((n) => n.id === ids[0]);
      if (dragged) {
        const portal = portalAtPoint(dragged);
        if (portal?.targetBoardId) {
          events.onCardDroppedOnPortal?.(ids[0], portal.targetBoardId);
          return;
        }
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
    const portal = portalAtPoint(node);
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
      className="canvas-focusable"
      tabIndex={0}
      onKeyDown={handleCanvasKeyDown}
      style={{ width: "100%", height: "100%" }}
    >
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        defaultViewport={viewport}
        translateExtent={[[0, 0], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]}
        nodeExtent={[[0, 0], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]}
        panOnScroll
        selectionOnDrag
        panOnDrag={[1, 2]}
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        nodesDraggable
        nodesConnectable={false}
        edgesFocusable={false}
        nodesFocusable
        elementsSelectable
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        onSelectionChange={handleSelectionChange}
        onPaneClick={handlePaneClick}
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
          instance.setViewport(viewportRef.current);
          onScreenToFlowReady?.((x, y) => instance.screenToFlowPosition({ x, y }));
        }}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
