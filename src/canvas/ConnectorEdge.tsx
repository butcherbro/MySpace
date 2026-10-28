import { useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import type { CanvasConnectorArrowEnds } from "./canvas-types";
import { connectorEndpoints } from "./connector-geometry";

export type ConnectorEdgeData = { colorToken: string; arrowEnds: CanvasConnectorArrowEnds };
export type ConnectorEdgeType = Edge<ConnectorEdgeData, "connector">;

function nodeRect(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  };
}

/**
 * «Плавающая» связь: прямая, нацеленная в центр карточки-цели и обрезанная по
 * границам обеих карточек. Прямоугольники узлов читаются из живого хранилища
 * React Flow, поэтому линия следует за карточкой прямо во время перетаскивания
 * или изменения размера, а не только после сохранения.
 */
export function ConnectorEdge({ id, source, target, data }: EdgeProps<ConnectorEdgeType>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const segment = connectorEndpoints(nodeRect(from), nodeRect(to));
  // Карточки перекрываются — линии между границами нет, ничего не рисуем.
  if (!segment) return null;

  const path = `M ${segment.x1} ${segment.y1} L ${segment.x2} ${segment.y2}`;
  // Маркер объявлен внутри группы ребра: так он наследует CSS-переменную цвета
  // этой связи (маркер берёт стили от своего места в DOM, а не от линии).
  const headId = `connector-head-${id}`;
  const head = `url(#${headId})`;
  return (
    <g
      className="connector-edge"
      data-testid="connector"
      data-connector-id={id}
      data-color-token={data.colorToken}
      data-arrow-ends={data.arrowEnds}
    >
      <defs>
        <marker
          id={headId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="12"
          markerHeight="12"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="connector-edge__head" />
        </marker>
      </defs>
      <path d={path} className="connector-edge__hit" />
      <path
        d={path}
        className="connector-edge__line"
        markerEnd={data.arrowEnds === "none" ? undefined : head}
        markerStart={data.arrowEnds === "both" ? head : undefined}
      />
    </g>
  );
}
