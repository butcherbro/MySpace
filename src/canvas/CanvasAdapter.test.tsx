import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import type { CanvasCard } from "./canvas-types";

const setViewport = vi.fn();
const reactFlowProps: unknown[] = [];
const backgroundProps: Array<{
  variant?: string;
  gap?: number;
  size?: number;
  color?: string;
}> = [];

vi.mock("@xyflow/react", async () => {
  await import("react");
  return {
    Background: (props: {
      variant?: string;
      gap?: number;
      size?: number;
      color?: string;
    }) => {
      backgroundProps.push(props);
      return null;
    },
    BackgroundVariant: { Dots: "dots" },
    SelectionMode: { Partial: "partial" },
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    ReactFlow: ({
      nodes,
      nodeTypes,
      children,
      onInit,
      ...props
    }: {
      nodes: Array<{ id: string; data: { content: React.ReactNode; kind: string }; selected?: boolean }>;
      nodeTypes?: {
        card?: (props: {
          data: { content: React.ReactNode; kind: string };
          selected?: boolean;
        }) => React.ReactNode;
      };
      children?: React.ReactNode;
      onInit?: (instance: {
        setViewport: typeof setViewport;
        screenToFlowPosition: (point: { x: number; y: number }) => { x: number; y: number };
      }) => void;
    }) => {
      useEffect(() => {
        reactFlowProps.push(props);
        onInit?.({
          setViewport,
          screenToFlowPosition: (point) => point,
        });
      });

      return (
        <div data-testid="react-flow">
          {nodes.map((node) => (
            <div key={node.id}>{nodeTypes?.card?.({ data: node.data, selected: node.selected }) ?? node.data.content}</div>
          ))}
          {children}
        </div>
      );
    },
  };
});

const cards: CanvasCard[] = [
  { id: "a", boardId: "home", kind: "note", frame: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0, revision: 1 },
  { id: "b", boardId: "home", kind: "note", frame: { x: 300, y: 0, width: 200, height: 80 }, zIndex: 1, revision: 1 },
];

describe("CanvasAdapter", () => {
  it("reapplies the requested viewport when a board-open reset token changes", () => {
    const { rerender } = render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => (
          <span data-testid={`card-${card.id}`}>{card.id}</span>
        )}
      />,
    );

    setViewport.mockClear();

    rerender(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1.5 }}
        viewportResetToken={2}
        events={{}}
        renderCard={(card) => (
          <span data-testid={`card-${card.id}`}>{card.id}</span>
        )}
      />,
    );

    expect(setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1.5 });
  });

  it("constrains panning to a top-left-anchored board surface", () => {
    reactFlowProps.length = 0;

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => (
          <span data-testid={`card-${card.id}`}>{card.id}</span>
        )}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      translateExtent?: [[number, number], [number, number]];
      nodeExtent?: [[number, number], [number, number]];
    };

    expect(props.translateExtent?.[0]).toEqual([0, 0]);
    expect(props.nodeExtent?.[0]).toEqual([0, 0]);
    expect(props.translateExtent?.[1]).toEqual([
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]);
    expect(props.nodeExtent?.[1]).toEqual([
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it("renders the interior of every card through renderCard", () => {
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => (
          <span data-testid={`card-${card.id}`}>{card.id}</span>
        )}
      />,
    );

    // renderCard is invoked for each card.
    expect(screen.getByTestId("card-a")).toBeInTheDocument();
    expect(screen.getByTestId("card-b")).toBeInTheDocument();
  });

  it("re-renders when a new card is added", () => {
    const { rerender } = render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );
    expect(screen.queryByTestId("card-c")).not.toBeInTheDocument();

    const more = [
      ...cards,
      { id: "c", boardId: "home", kind: "note" as const, frame: { x: 0, y: 200, width: 200, height: 80 }, zIndex: 2, revision: 1 },
    ];
    rerender(
      <CanvasAdapter
        cards={more}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );
    expect(screen.getByTestId("card-c")).toBeInTheDocument();
  });

  it("emits onPaneDoubleClick with a board-space point after two quick pane clicks", () => {
    reactFlowProps.length = 0;
    const onPaneDoubleClick = vi.fn();

    vi.useFakeTimers();
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{ onPaneDoubleClick }}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      onPaneClick?: (e: { clientX: number; clientY: number }) => void;
    };
    expect(props.onPaneClick).toBeTypeOf("function");

    // First click, then a second click well within the double-click window.
    props.onPaneClick!({ clientX: 120, clientY: 80 });
    vi.advanceTimersByTime(100);
    props.onPaneClick!({ clientX: 121, clientY: 81 });

    expect(onPaneDoubleClick).toHaveBeenCalledTimes(1);
    expect(onPaneDoubleClick).toHaveBeenCalledWith({ x: 121, y: 81 });
    vi.useRealTimers();
  });

  it("does not emit onPaneDoubleClick for two slow pane clicks", () => {
    reactFlowProps.length = 0;
    const onPaneDoubleClick = vi.fn();

    vi.useFakeTimers();
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{ onPaneDoubleClick }}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      onPaneClick?: (e: { clientX: number; clientY: number }) => void;
    };

    props.onPaneClick!({ clientX: 120, clientY: 80 });
    vi.advanceTimersByTime(600); // beyond the double-click window
    props.onPaneClick!({ clientX: 121, clientY: 81 });

    expect(onPaneDoubleClick).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("re-renders a card when its revision changes (content edit)", () => {
    const renderContent = (text: string, revision: number) =>
      render(
        <CanvasAdapter
          cards={cards.map((c) => (c.id === "a" ? { ...c, revision } : c))}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          viewportResetToken={1}
          events={{}}
          renderCard={(card) => (
            <span data-testid={`card-${card.id}`}>
              {card.id === "a" ? text : card.id}
            </span>
          )}
        />,
      );

    renderContent("hello", 2);
    expect(screen.getByTestId("card-a")).toHaveTextContent("hello");
  });

  it("renders a desk surface root and quiet dot background", () => {
    reactFlowProps.length = 0;
    backgroundProps.length = 0;

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );

    expect(screen.getByTestId("canvas-surface")).toHaveAttribute("data-kind", "desk");

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      proOptions?: { hideAttribution?: boolean };
    };
    expect(props.proOptions?.hideAttribution).not.toBe(true);

    expect(backgroundProps[backgroundProps.length - 1]).toMatchObject({
      variant: "dots",
      gap: 20,
      size: 1,
      color: "var(--desk-dot)",
    });
  });

  it("renders each card through a dedicated frame class", () => {
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
      />,
    );

    const card = screen.getByTestId("card-a");
    const frame = card.closest(".canvas-card-frame");
    expect(frame).toHaveAttribute("data-card-kind", "note");
    expect(frame).not.toHaveAttribute("data-kind");
  });

  it("rebuilds the card frame when kind changes without moving or revising the card", () => {
    const { rerender } = render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
      />,
    );

    expect(screen.getByTestId("card-a").closest(".canvas-card-frame")).toHaveAttribute(
      "data-card-kind",
      "note",
    );

    const next = cards.map((card) =>
      card.id === "a" ? { ...card, kind: "image" as const } : card,
    );

    rerender(
      <CanvasAdapter
        cards={next}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
      />,
    );

    expect(screen.getByTestId("card-a").closest(".canvas-card-frame")).toHaveAttribute(
      "data-card-kind",
      "image",
    );
  });
});
