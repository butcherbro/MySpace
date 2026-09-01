import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import type { CanvasCard } from "./canvas-types";

const cards: CanvasCard[] = [
  { id: "a", boardId: "home", kind: "note", frame: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0, revision: 1 },
  { id: "b", boardId: "home", kind: "note", frame: { x: 300, y: 0, width: 200, height: 80 }, zIndex: 1, revision: 1 },
];

describe("CanvasAdapter", () => {
  it("renders the interior of every card through renderCard", () => {
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
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
        events={{}}
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );
    expect(screen.getByTestId("card-c")).toBeInTheDocument();
  });

  it("re-renders a card when its revision changes (content edit)", () => {
    const renderContent = (text: string, revision: number) =>
      render(
        <CanvasAdapter
          cards={cards.map((c) => (c.id === "a" ? { ...c, revision } : c))}
          viewport={{ x: 0, y: 0, zoom: 1 }}
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
});
