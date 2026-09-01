import { useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
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
}: CanvasAdapterProps) {
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>(() =>
    cards.map((c) => cardToNode(c, renderCard)),
  );

  // Detect any change to the external projection (frame *or* revision, which
  // changes on content edits and moves) and rebuild nodes as part of render
  // (React's recommended "adjusting state during render" pattern). Rebuilding
  // on revision change refreshes node content without a separate content key.
  const cardsKey = cards
    .map((c) => `${c.id}:${c.frame.x},${c.frame.y},${c.frame.width},${c.frame.height},${c.zIndex},${c.revision}`)
    .join("|");
  const [lastKey, setLastKey] = useState(cardsKey);

  if (cardsKey !== lastKey) {
    setLastKey(cardsKey);
    setNodes(cards.map((c) => cardToNode(c, renderCard)));
  }

  const nodeTypes: NodeTypes = {
    card: ({ data }) => <>{data.content}</>,
  };

  const handleNodesChange = (changes: NodeChange<Node<CardNodeData>>[]) => {
    setNodes((prev) => applyNodeChanges(changes, prev) as Node<CardNodeData>[]);
  };

  const handleSelectionChange = (params: OnSelectionChangeParams) => {
    events.onSelectionChanged?.({ ids: params.nodes.map((n) => n.id) });
  };

  const handleNodeDragStop = (_: unknown, node: Node<CardNodeData>) => {
    const source = cards.find((c) => c.id === node.id);
    if (!source) return;
    const moved = movedNodeToCard({
      id: node.id,
      position: node.position,
      width: node.width ?? source.frame.width,
      height: node.height ?? source.frame.height,
      zIndex: source.zIndex,
    }, source);
    events.onCardsMoved?.({ cards: [{ id: moved.id, frame: moved.frame }] });
  };

  const handleMoveEnd = (_: unknown, vp: { x: number; y: number; zoom: number }) => {
    events.onViewportChanged?.({ viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } });
  };

  return (
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
      selectNodesOnDrag={false}
      onSelectionChange={handleSelectionChange}
      onNodeDragStop={handleNodeDragStop}
      onMoveEnd={handleMoveEnd}
      minZoom={0.1}
      maxZoom={4}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
    </ReactFlow>
  );
}
