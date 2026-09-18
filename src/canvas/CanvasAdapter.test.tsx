import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import { ImageCard } from "../cards/image/ImageCard";
import type { CanvasCard } from "./canvas-types";
import type { ImageCardDto } from "../services/workspace-gateway";

const setViewport = vi.fn();
const setCenter = vi.fn();
const getZoom = vi.fn(() => 1);
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
        setCenter: typeof setCenter;
        getZoom: typeof getZoom;
      }) => void;
    }) => {
      useEffect(() => {
        reactFlowProps.push(props);
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
      gap: 20,
      size: 3,
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
    };
    const portalA: CanvasCard = {
      id: "pA",
      boardId: "home",
      kind: "board_portal",
      frame: { x: 250, y: 0, width: 100, height: 100 },
      zIndex: 1,
      revision: 1,
      targetBoardId: "board-a",
    };
    const portalB: CanvasCard = {
      id: "pB",
      boardId: "home",
      kind: "board_portal",
      frame: { x: 0, y: 0, width: 100, height: 100 },
      zIndex: 1,
      revision: 1,
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
});
