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
  events,
  renderCard,
  editingCardId = null,
  onScreenToFlowReady,
}: CanvasAdapterProps) {
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>(() =>
    cards.map((c) => cardToNode(c, renderCard)),
  );

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

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

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
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeContextMenu={handleNodeContextMenu}
        onSelectionContextMenu={handleSelectionContextMenu}
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
        onInit={(instance) => {
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
