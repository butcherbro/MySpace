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
}

type CardNodeData = { content: ReactNode };

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
 *
 * Node state is kept internally and re-synced whenever `cards` change from
 * outside (e.g. a note is added or a snapshot reloads). Only domain types cross
 * this component's boundary.
 */
export function CanvasAdapter({
  cards,
  viewport,
  events,
  renderCard,
  editingCardId = null,
}: CanvasAdapterProps) {
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>(() =>
    cards.map((c) => cardToNode(c, renderCard)),
  );

  // Detect any change to the external projection (frame *or* revision, which
  // changes on content edits and moves) and rebuild nodes as part of render
  // (React's recommended "adjusting state during render" pattern). Rebuilding
  // on revision change refreshes node content without a separate content key.
  const cardsKey =
    cards
      .map((c) => `${c.id}:${c.frame.x},${c.frame.y},${c.frame.width},${c.frame.height},${c.zIndex},${c.revision}`)
      .join("|") + `#edit:${editingCardId ?? ""}`;
  const [lastKey, setLastKey] = useState(cardsKey);

  if (cardsKey !== lastKey) {
    setLastKey(cardsKey);
    setNodes(cards.map((c) => cardToNode(c, renderCard)));
  }

  const nodesRef = useRef(nodes);
  const selectedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const nodeTypes: NodeTypes = {
    card: ({ data }) => (
      <div style={{ width: "100%", height: "100%" }}>{data.content}</div>
    ),
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
    // Determine the set of cards that moved together. If this node was part of
    // a multi-selection, move all selected cards; otherwise just this one.
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
    // A pure click (no drag) on a note activates editing; on a portal it will
    // open the child board (Slice 4). Modifier-clicks are selection gestures,
    // not activation.
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      return;
    }
    if (!selectedIdsRef.current.has(node.id) || selectedIdsRef.current.size <= 1) {
      events.onCardActivated?.(node.id);
    }
  };

  const handleMoveEnd = (_: unknown, vp: { x: number; y: number; zoom: number }) => {
    events.onViewportChanged?.({ viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } });
  };

  const handleCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Canvas-only Cmd/Ctrl+A: select all cards. Inside an editor the textarea
    // handles its own select-all natively and never bubbles a plain A here.
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
        panOnDrag={false}
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
        onNodeDragStop={handleNodeDragStop}
        onMoveEnd={handleMoveEnd}
        minZoom={0.1}
        maxZoom={4}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
