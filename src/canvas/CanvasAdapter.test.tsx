import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import { ImageCard } from "../cards/image/ImageCard";
import type { CanvasCard, CanvasConnector } from "./canvas-types";
import type { ImageCardDto } from "../services/workspace-gateway";

const setViewport = vi.fn();
const setCenter = vi.fn();
const getZoom = vi.fn(() => 1);
const reactFlowProps: unknown[] = [];
const reactFlowNodes: Array<Array<{ id: string; zIndex?: number; position: { x: number; y: number } }>> = [];
const backgroundProps: Array<{
  variant?: string;
  gap?: number;
  size?: number;
  color?: string;
}> = [];

// The overlay scrollbars read React Flow's store (covered by the geometry unit
// tests and the canvas-scroll e2e); this mock has no store to give them.
vi.mock("./CanvasScrollbars", () => ({ CanvasScrollbars: () => null }));

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
    ConnectionLineType: { Straight: "straight" },
    Position: { Top: "top", Right: "right" },
    Handle: ({ className, ...props }: { className?: string; "data-testid"?: string }) => (
      <div className={className} data-testid={props["data-testid"]} />
    ),
    SelectionMode: { Partial: "partial" },
    // Только выделение: остальные изменения тестам не нужны.
    applyNodeChanges: (
      changes: Array<{ type: string; id: string; selected?: boolean; position?: { x: number; y: number } }>,
      nodes: Array<{ id: string; selected?: boolean; position?: { x: number; y: number } }>,
    ) => {
      const relevant = changes.filter((c) => c.type === "select" || c.type === "position");
      if (relevant.length === 0) return nodes;
      return nodes.map((n) => {
        let next = n;
        for (const change of relevant) {
          if (change.id !== n.id) continue;
          next =
            change.type === "select" ? { ...next, selected: change.selected } : { ...next, position: change.position };
        }
        return next;
      });
    },
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
        setCenter: typeof setCenter;
        getZoom: typeof getZoom;
      }) => void;
    }) => {
      useEffect(() => {
        reactFlowProps.push(props);
        reactFlowNodes.push(nodes as unknown as (typeof reactFlowNodes)[number]);
        onInit?.({
          setViewport,
          screenToFlowPosition: (point) => point,
          setCenter,
          getZoom,
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
  { id: "a", boardId: "home", kind: "note", frame: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0, revision: 1, groupId: null },
  { id: "b", boardId: "home", kind: "note", frame: { x: 300, y: 0, width: 200, height: 80 }, zIndex: 1, revision: 1, groupId: null },
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

  it("Space held switches to pan mode (left-drag pans, no marquee, no card drag) and releases on keyup", () => {
    reactFlowProps.length = 0;
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={{}}
        renderCard={(card) => <span>{card.id}</span>}
      />,
    );
    type PanProps = { panOnDrag?: unknown; selectionOnDrag?: boolean; nodesDraggable?: boolean; panActivationKeyCode?: unknown };
    const last = () => reactFlowProps[reactFlowProps.length - 1] as PanProps;
    expect(last()).toMatchObject({ panOnDrag: [1, 2], selectionOnDrag: true, nodesDraggable: true, panActivationKeyCode: null });

    const keydown = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(keydown);
    });
    expect(keydown.defaultPrevented).toBe(true);
    expect(last()).toMatchObject({ panOnDrag: [0, 1, 2], selectionOnDrag: false, nodesDraggable: false });
    expect(screen.getByTestId("canvas-surface").getAttribute("data-space-pan")).toBe("true");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
    });
    expect(last()).toMatchObject({ panOnDrag: [1, 2], selectionOnDrag: true, nodesDraggable: true });
  });

  it("Space typed into a text field or contenteditable never starts pan mode", () => {
    reactFlowProps.length = 0;
    render(
      <>
        <textarea data-testid="field" />
        <div data-testid="editor" contentEditable suppressContentEditableWarning>
          <p data-testid="editor-p">text</p>
        </div>
        <CanvasAdapter
          cards={cards}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          events={{}}
          renderCard={(card) => <span>{card.id}</span>}
        />
      </>,
    );
    for (const id of ["field", "editor-p"]) {
      const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
      act(() => {
        screen.getByTestId(id).dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(screen.getByTestId("canvas-surface").getAttribute("data-space-pan")).toBeNull();
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

  it("leaves deletion to the durable workspace command layer", () => {
    reactFlowProps.length = 0;

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={{}}
        renderCard={(card) => <span>{card.id}</span>}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      deleteKeyCode?: string | null;
    };
    expect(props.deleteKeyCode).toBeNull();
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
      { id: "c", boardId: "home", kind: "note" as const, frame: { x: 0, y: 200, width: 200, height: 80 }, zIndex: 2, revision: 1, groupId: null },
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
    expect(onPaneDoubleClick).toHaveBeenCalledWith({ x: 121, y: 81 }, { x: 121, y: 81 });
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

  it("emits onPaneContextMenu with screen coordinates on pane right-click", () => {
    reactFlowProps.length = 0;
    const onPaneContextMenu = vi.fn();

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{ onPaneContextMenu }}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      onPaneContextMenu?: (e: { clientX: number; clientY: number; preventDefault: () => void }) => void;
    };
    expect(props.onPaneContextMenu).toBeTypeOf("function");

    const preventDefault = vi.fn();
    props.onPaneContextMenu!({ clientX: 50, clientY: 70, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onPaneContextMenu).toHaveBeenCalledWith(50, 70);
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

  it("centers and selects a requested focus card", () => {
    setCenter.mockClear();
    getZoom.mockClear();
    const onSelectionChanged = vi.fn();

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        focusRequest={{ cardId: "a", token: 1 }}
        events={{ onSelectionChanged }}
        renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
      />,
    );

    // Card "a" is at (0,0,200,80), so its center is (100,40).
    expect(setCenter).toHaveBeenCalledWith(100, 40, { zoom: 1, duration: 0 });
    expect(onSelectionChanged).toHaveBeenCalledWith({ ids: ["a"] });
  });

  it("renders the Milanote-calibrated desk dot grid", () => {
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
      gap: 22,
      size: 1.4,
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

  it("finishes a drag whose node disappeared with the snapshot without throwing", () => {
    reactFlowProps.length = 0;
    const onCardDragEnd = vi.fn(() => false);
    const onCardsMoved = vi.fn();

    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        viewportResetToken={1}
        events={{ onCardDragEnd, onCardsMoved }}
        renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
      />,
    );

    const props = reactFlowProps[reactFlowProps.length - 1] as {
      onNodeDragStart?: (event: MouseEvent, node: { id: string }) => void;
      onNodeDragStop?: (event: MouseEvent, node?: { id: string }) => void;
    };

    props.onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "a" });

    // A cross-board drop replaced the board snapshot, so drag-stop comes back
    // without the node the session started on: the drag must still finish.
    expect(() => props.onNodeDragStop?.(new MouseEvent("pointerup"))).not.toThrow();

    // The session ended through the normal cleanup path.
    expect(onCardDragEnd).toHaveBeenCalled();

    // Persistence is never handed an entry without a frame.
    for (const [payload] of onCardsMoved.mock.calls as Array<[{ cards: Array<{ frame?: unknown }> }]>) {
      for (const card of payload.cards) {
        expect(card.frame).toBeDefined();
      }
    }
  });

  describe("portal drop target (todo.md №22)", () => {
    // A big note that overlaps portal A only partially (ratio 0.5) but
    // overlaps portal B fully (ratio 1.0) -- the OLD pure frame-overlap
    // resolution would always pick B here, even when the user's cursor is
    // clearly over A when they let go.
    const bigNote: CanvasCard = {
      id: "n1",
      boardId: "home",
      kind: "note",
      frame: { x: 0, y: 0, width: 300, height: 100 },
      zIndex: 0,
      revision: 1,
      groupId: null,
    };
    const portalA: CanvasCard = {
      id: "pA",
      boardId: "home",
      kind: "board_portal",
      frame: { x: 250, y: 0, width: 100, height: 100 },
      zIndex: 1,
      revision: 1,
      groupId: null,
      targetBoardId: "board-a",
    };
    const portalB: CanvasCard = {
      id: "pB",
      boardId: "home",
      kind: "board_portal",
      frame: { x: 0, y: 0, width: 100, height: 100 },
      zIndex: 1,
      revision: 1,
      groupId: null,
      targetBoardId: "board-b",
    };
    // A second plain card, far from both portals, used only to prove group
    // drops resolve by the single shared cursor position, not by any one
    // selected node's own frame.
    const farNote: CanvasCard = {
      id: "n2",
      boardId: "home",
      kind: "note",
      frame: { x: 800, y: 800, width: 50, height: 50 },
      zIndex: 0,
      revision: 1,
      groupId: null,
    };
    const portalCards = [bigNote, farNote, portalA, portalB];

    function renderPortalCanvas(events: Parameters<typeof CanvasAdapter>[0]["events"]) {
      reactFlowProps.length = 0;
      render(
        <CanvasAdapter
          cards={portalCards}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          viewportResetToken={1}
          events={events}
          renderCard={(card) => <span data-testid={`card-${card.id}`}>{card.id}</span>}
        />,
      );
      return reactFlowProps[reactFlowProps.length - 1] as {
        onNodeDragStart?: (event: MouseEvent, node: { id: string }) => void;
        onNodeDragStop?: (event: MouseEvent, node?: { id: string }) => void;
        onNodeDrag?: (event: MouseEvent, node: { id: string }) => void;
        onSelectionChange?: (params: { nodes: Array<{ id: string }> }) => void;
      };
    }

    it("drops onto the portal under the cursor, not the one with more frame overlap", () => {
      const onCardsDroppedOnPortal = vi.fn();
      const props = renderPortalCanvas({ onCardsDroppedOnPortal });

      props.onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "n1" });
      // Cursor sits inside portal A's frame (x 250-350, y 0-100).
      props.onNodeDragStop?.(
        { clientX: 280, clientY: 50 } as unknown as MouseEvent,
        { id: "n1" },
      );

      expect(onCardsDroppedOnPortal).toHaveBeenCalledWith(["n1"], "board-a");
    });

    it("drops onto portal B when the cursor is over B instead", () => {
      const onCardsDroppedOnPortal = vi.fn();
      const props = renderPortalCanvas({ onCardsDroppedOnPortal });

      props.onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "n1" });
      // Cursor sits inside portal B's frame (x 0-100, y 0-100).
      props.onNodeDragStop?.(
        { clientX: 50, clientY: 50 } as unknown as MouseEvent,
        { id: "n1" },
      );

      expect(onCardsDroppedOnPortal).toHaveBeenCalledWith(["n1"], "board-b");
    });

    it("falls back to frame overlap when the cursor is over neither portal", () => {
      const onCardsDroppedOnPortal = vi.fn();
      const props = renderPortalCanvas({ onCardsDroppedOnPortal });

      props.onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "n1" });
      // Cursor is over the note but outside both portal frames (x 175 is
      // between A's start at 250 and B's end at 100).
      props.onNodeDragStop?.(
        { clientX: 175, clientY: 50 } as unknown as MouseEvent,
        { id: "n1" },
      );

      // Overlap-only resolution: B (ratio 1.0) beats A (ratio 0.5).
      expect(onCardsDroppedOnPortal).toHaveBeenCalledWith(["n1"], "board-b");
    });

    it("resolves a group drag by the single cursor position, not per-node overlap", () => {
      const onCardsDroppedOnPortal = vi.fn();
      const props = renderPortalCanvas({ onCardsDroppedOnPortal });

      // Select both n1 and the far-away n2, then drag n1 (the group's anchor).
      // n2's own frame is nowhere near either portal; only the shared cursor
      // position should decide the target for the whole group.
      props.onSelectionChange?.({ nodes: [{ id: "n1" }, { id: "n2" }] });
      props.onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "n1" });
      props.onNodeDragStop?.(
        { clientX: 280, clientY: 50 } as unknown as MouseEvent,
        { id: "n1" },
      );

      expect(onCardsDroppedOnPortal).toHaveBeenCalledWith(
        expect.arrayContaining(["n1", "n2"]),
        "board-a",
      );
    });

    it("highlights the same portal during drag that the drop would land on", () => {
      const onPortalHighlight = vi.fn();
      const props = renderPortalCanvas({ onPortalHighlight });

      props.onNodeDrag?.(
        { clientX: 280, clientY: 50 } as unknown as MouseEvent,
        { id: "n1" },
      );

      expect(onPortalHighlight).toHaveBeenCalledWith("pA");
    });
  });

  describe("groups (ADR-0013)", () => {
    const group: CanvasCard = {
      id: "g",
      boardId: "home",
      kind: "group",
      frame: { x: 0, y: 0, width: 400, height: 300 },
      zIndex: 5,
      revision: 1,
      groupId: null,
    };
    const inside: CanvasCard = {
      ...cards[0],
      id: "in",
      frame: { x: 20, y: 40, width: 100, height: 60 },
      zIndex: 0,
      groupId: "g",
    };
    const alsoInside: CanvasCard = {
      ...cards[0],
      id: "in2",
      frame: { x: 200, y: 100, width: 100, height: 60 },
      zIndex: 0,
      groupId: "g",
    };
    const outside: CanvasCard = { ...cards[0], id: "out", frame: { x: 500, y: 0, width: 100, height: 60 }, zIndex: 0 };
    const portal: CanvasCard = {
      id: "p",
      boardId: "home",
      kind: "board_portal",
      frame: { x: 600, y: 400, width: 100, height: 100 },
      zIndex: 1,
      revision: 1,
      groupId: null,
      targetBoardId: "board-p",
    };

    type DragProps = {
      onNodeDragStart?: (event: MouseEvent, node: { id: string; position: { x: number; y: number } }) => void;
      onNodeDrag?: (event: MouseEvent, node: { id: string; position: { x: number; y: number } }) => void;
      onNodeDragStop?: (event: MouseEvent, node?: { id: string; position: { x: number; y: number } }) => void;
      onSelectionChange?: (params: { nodes: Array<{ id: string }>; edges: Array<{ id: string }> }) => void;
    };

    function renderGroupCanvas(events: Parameters<typeof CanvasAdapter>[0]["events"]) {
      reactFlowProps.length = 0;
      reactFlowNodes.length = 0;
      render(
        <CanvasAdapter
          cards={[group, inside, alsoInside, outside, portal]}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          viewportResetToken={1}
          events={events}
          renderCard={(card) => <span>{card.id}</span>}
        />,
      );
      return () => reactFlowProps[reactFlowProps.length - 1] as DragProps;
    }

    it("puts group nodes in a z band below every other card and turns React Flow's own lift off", () => {
      const props = renderGroupCanvas({});
      const nodes = reactFlowNodes[reactFlowNodes.length - 1];
      // 400×300 = 120 000 px² → −12.
      expect(nodes.find((n) => n.id === "g")?.zIndex).toBe(-10012);
      expect(nodes.find((n) => n.id === "in")?.zIndex).toBe(0);
      expect((props() as { elevateNodesOnSelect?: boolean }).elevateNodesOnSelect).toBe(false);
    });

    it("lifts a selected card by 1000 but never a selected group", () => {
      const props = renderGroupCanvas({});
      act(() =>
        (props() as { onNodesChange?: (changes: unknown[]) => void }).onNodesChange?.([
          { type: "select", id: "g", selected: true },
          { type: "select", id: "in", selected: true },
        ]),
      );
      const nodes = reactFlowNodes[reactFlowNodes.length - 1];
      expect(nodes.find((n) => n.id === "g")?.zIndex).toBe(-10012);
      expect(nodes.find((n) => n.id === "in")?.zIndex).toBe(1000);
      expect(nodes.find((n) => n.id === "out")?.zIndex).toBe(0);
    });

    it("moves the cards inside with the frame and persists them in one move, outside cards untouched", () => {
      const onCardsMoved = vi.fn();
      const onCardDragMove = vi.fn();
      const onCardsDroppedOnPortal = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved, onCardDragMove, onCardsDroppedOnPortal });

      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "g", position: { x: 0, y: 0 } }));
      act(() =>
        props().onNodeDrag?.({ clientX: 650, clientY: 450 } as unknown as MouseEvent, { id: "g", position: { x: 120, y: 80 } }),
      );

      // Во время жеста члены уже стоят со смещением рамки.
      const live = reactFlowNodes[reactFlowNodes.length - 1];
      expect(live.find((n) => n.id === "in")?.position).toEqual({ x: 140, y: 120 });
      expect(live.find((n) => n.id === "out")?.position).toEqual({ x: 500, y: 0 });

      // Отпущено над порталом: жест с группой — только перемещение по доске.
      act(() =>
        props().onNodeDragStop?.({ clientX: 650, clientY: 450 } as unknown as MouseEvent, { id: "g", position: { x: 120, y: 80 } }),
      );

      expect(onCardsDroppedOnPortal).not.toHaveBeenCalled();
      expect(onCardDragMove).not.toHaveBeenCalled();
      expect(onCardsMoved).toHaveBeenCalledTimes(1);
      const moved = onCardsMoved.mock.calls[0][0] as { cards: Array<{ id: string; frame: CanvasCard["frame"] }> };
      expect(moved.cards.map((c) => c.id)).toEqual(["g", "in", "in2"]);
      expect(moved.cards.find((c) => c.id === "in")?.frame).toEqual({ x: 140, y: 120, width: 100, height: 60 });
      expect(moved.cards.find((c) => c.id === "in2")?.frame).toEqual({ x: 320, y: 180, width: 100, height: 60 });
    });

    it("does not list a member twice when it is also selected", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });

      act(() => props().onSelectionChange?.({ nodes: [{ id: "g" }, { id: "in" }], edges: [] }));
      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "g", position: { x: 0, y: 0 } }));
      act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id: "g", position: { x: 10, y: 10 } }));

      const moved = onCardsMoved.mock.calls[0][0] as { cards: Array<{ id: string }> };
      expect(moved.cards.map((c) => c.id).sort()).toEqual(["g", "in", "in2"]);
    });

    it("a plain card drag moves nothing else", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });

      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "in", position: { x: 20, y: 40 } }));
      act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id: "in", position: { x: 600, y: 40 } }));

      const moved = onCardsMoved.mock.calls[0][0] as { cards: Array<{ id: string }> };
      expect(moved.cards.map((c) => c.id)).toEqual(["in"]);
    });

    type Moved = { cards: Array<{ id: string; frame: CanvasCard["frame"]; group?: { groupId: string | null } }> };

    it("a frame dropped over a foreign card does not take it: members come from groupId, not geometry", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });

      // Рамка накрывает «out» (500..600 × 0..60) целиком.
      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "g", position: { x: 0, y: 0 } }));
      act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id: "g", position: { x: 300, y: 0 } }));

      const moved = onCardsMoved.mock.calls[0][0] as Moved;
      expect(moved.cards.map((c) => c.id)).toEqual(["g", "in", "in2"]);
      // Ни рамка, ни члены, которых она везла, членство не меняют.
      expect(moved.cards.every((c) => c.group === undefined)).toBe(true);
    });

    it("a card dropped inside a frame joins it; a member dropped outside leaves it", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });
      // Узел ставим туда, куда его довёл бы React Flow, и отпускаем.
      const drag = (id: string, from: { x: number; y: number }, to: { x: number; y: number }) => {
        act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id, position: from }));
        act(() =>
          (props() as { onNodesChange?: (changes: unknown[]) => void }).onNodesChange?.([
            { type: "position", id, position: to },
          ]),
        );
        act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id, position: to }));
      };

      drag("out", { x: 500, y: 0 }, { x: 100, y: 200 });
      expect((onCardsMoved.mock.calls[0][0] as Moved).cards).toEqual([
        { id: "out", frame: { x: 100, y: 200, width: 100, height: 60 }, group: { groupId: "g" } },
      ]);

      drag("in", { x: 20, y: 40 }, { x: 1000, y: 40 });
      expect((onCardsMoved.mock.calls[1][0] as Moved).cards).toEqual([
        { id: "in", frame: { x: 1000, y: 40, width: 100, height: 60 }, group: { groupId: null } },
      ]);

      // Внутри своей же рамки — членство то же, поля нет.
      drag("in2", { x: 200, y: 100 }, { x: 60, y: 60 });
      expect((onCardsMoved.mock.calls[2][0] as Moved).cards[0].group).toBeUndefined();
    });

    it("a selection drag with a group neither re-evaluates its members nor lets the moved frame take cards", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });
      act(() => props().onSelectionChange?.({ nodes: [{ id: "g" }, { id: "in" }, { id: "out" }], edges: [] }));
      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "g", position: { x: 0, y: 0 } }));
      // Рамка накрыла «out»; «in» (её член) оказался далеко за ней.
      act(() =>
        (props() as { onNodesChange?: (changes: unknown[]) => void }).onNodesChange?.([
          { type: "position", id: "g", position: { x: 450, y: 0 } },
          { type: "position", id: "out", position: { x: 500, y: 20 } },
          { type: "position", id: "in", position: { x: 2000, y: 2000 } },
        ]),
      );
      act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id: "g", position: { x: 450, y: 0 } }));

      const moved = (onCardsMoved.mock.calls[0][0] as Moved).cards;
      expect(moved.map((c) => c.id).sort()).toEqual(["g", "in", "in2", "out"]);
      expect(moved.every((c) => c.group === undefined)).toBe(true);
    });

    it("tests the drop against the frame's live node, not the stale `cards` prop", () => {
      const onCardsMoved = vi.fn();
      const props = renderGroupCanvas({ onCardsMoved });
      const onNodesChange = (changes: unknown[]) =>
        act(() => (props() as { onNodesChange?: (changes: unknown[]) => void }).onNodesChange?.(changes));
      // Рамка уже сдвинута на холсте (ответ MoveCards ещё не пришёл, `cards` старые).
      onNodesChange([{ type: "position", id: "g", position: { x: 1000, y: 1000 } }]);

      act(() => props().onNodeDragStart?.(new MouseEvent("pointerdown"), { id: "out", position: { x: 500, y: 0 } }));
      onNodesChange([{ type: "position", id: "out", position: { x: 1100, y: 1100 } }]);
      act(() => props().onNodeDragStop?.(new MouseEvent("pointerup"), { id: "out", position: { x: 1100, y: 1100 } }));
      expect((onCardsMoved.mock.calls[0][0] as Moved).cards[0].group).toEqual({ groupId: "g" });
    });
  });

  /**
   * Regression for "ghost frame" during resize (backlog problem 7): the
   * `.canvas-card-frame` wrapper `nodeTypes.card` renders used to be forced
   * to `width: 100%; height: 100%` of its React Flow node — a box sized from
   * `card.frame.width/height` (persisted), unchanged until the resize
   * commits on pointer-up. Every resizable card already tracks its own live
   * drag size on its own root (`appliedWidth`/`appliedHeight`, applied as an
   * inline `style`), so the wrapper's forced 100% sat at the stale size
   * while the content inside it visibly shrank — the ghost border. The
   * wrapper must instead take its size from its child (one source of truth),
   * so it has no competing width/height of its own.
   */
  it("does not force the card frame to a fixed size that could go stale during a resize drag", () => {
    const image: ImageCardDto = {
      kind: "image",
      id: "img-1",
      boardId: "home",
      frame: { x: 0, y: 0, width: 320, height: 240 },
      zIndex: 0,
      revision: 1,
      groupId: null,
      asset: {
        id: "asset-1",
        fileName: "shot.png",
        mimeType: "image/png",
        width: null,
        height: null,
        sizeBytes: 1024,
        filePath: "asset-1.png",
      },
      captionJson: {},
      captionPlainText: "",
    };

    render(
      <CanvasAdapter
        cards={[{ ...image }]}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={{}}
        renderCard={() => (
          <ImageCard
            image={image}
            onUpdate={async () => {}}
            onResize={() => {}}
            onContextMenu={() => {}}
          />
        )}
      />,
    );

    const frame = document.querySelector(".canvas-card-frame") as HTMLElement;
    expect(frame).toBeTruthy();
    // The wrapper must not carry its own competing size: it has to hug
    // whatever the card inside it renders at, at every point during a drag.
    expect(frame.style.width).toBe("");
    expect(frame.style.height).toBe("");

    const contentRoot = screen.getByTestId("image-card");
    expect(contentRoot.style.width).toBe("320px");

    // Drag the resize handle inward, well before pointer-up (the commit).
    const handle = screen.getByTestId("image-resize");
    // jsdom doesn't implement the Pointer Events capture API used by the drag handler.
    (handle as unknown as { setPointerCapture: () => void }).setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { clientX: 300, clientY: 220 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 160 });

    // The content shrinks immediately...
    expect(contentRoot.style.width).toBe("220px");
    expect(contentRoot.style.height).toBe("180px");
    // ...and the frame wrapper still has no fixed size of its own fighting
    // it: nothing pins it to the pre-drag 320x240 box.
    expect(frame.style.width).toBe("");
    expect(frame.style.height).toBe("");
  });

  it("drops a deleted connector from the edge selection and reports the pruned selection", () => {
    reactFlowProps.length = 0;
    const connector: CanvasConnector = { id: "c1", fromCardId: "a", toCardId: "b", colorToken: "default", arrowEnds: "end" };
    const onConnectorSelectionChanged = vi.fn();
    const events = { onConnectorSelectionChanged };
    type EdgeProps = {
      edges: Array<{ id: string; selected?: boolean }>;
      onEdgesChange: (changes: Array<{ type: "select"; id: string; selected: boolean }>) => void;
    };
    const last = () => reactFlowProps[reactFlowProps.length - 1] as EdgeProps;
    const view = (connectors: CanvasConnector[]) => (
      <CanvasAdapter
        cards={cards}
        connectors={connectors}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={events}
        renderCard={(card) => <span>{card.id}</span>}
      />
    );
    const { rerender } = render(view([connector]));
    act(() => last().onEdgesChange([{ type: "select", id: "c1", selected: true }]));
    expect(last().edges).toEqual([expect.objectContaining({ id: "c1", selected: true })]);

    rerender(view([]));
    expect(onConnectorSelectionChanged).toHaveBeenLastCalledWith({ ids: [] });

    // Undo вернул связь: она приходит невыделенной.
    rerender(view([connector]));
    expect(last().edges).toEqual([expect.objectContaining({ id: "c1", selected: false })]);
  });
});
