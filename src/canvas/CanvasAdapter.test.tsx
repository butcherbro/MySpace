import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import type { CanvasCard } from "./canvas-types";

const cards: CanvasCard[] = [
  { id: "a", boardId: "home", kind: "note", frame: { x: 0, y: 0, width: 200, height: 80 }, zIndex: 0 },
  { id: "b", boardId: "home", kind: "note", frame: { x: 300, y: 0, width: 200, height: 80 }, zIndex: 1 },
];

describe("CanvasAdapter", () => {
  it("renders the interior of every card through renderCard", () => {
    render(
      <CanvasAdapter
        cards={cards}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={{}}
        dependencyKey="v1"
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
        dependencyKey="v1"
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );
    expect(screen.queryByTestId("card-c")).not.toBeInTheDocument();

    const more = [
      ...cards,
      { id: "c", boardId: "home", kind: "note" as const, frame: { x: 0, y: 200, width: 200, height: 80 }, zIndex: 2 },
    ];
    rerender(
      <CanvasAdapter
        cards={more}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        events={{}}
        dependencyKey="v2"
        renderCard={(card) => <span data-testid={`card-${card.id}`} />}
      />,
    );
    expect(screen.getByTestId("card-c")).toBeInTheDocument();
  });

  it("re-renders content when dependencyKey changes (text edit)", () => {
    const renderContent = (text: string) =>
      render(
        <CanvasAdapter
          cards={cards}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          events={{}}
          dependencyKey={text}
          renderCard={(card) => (
            <span data-testid={`card-${card.id}`}>{text}</span>
          )}
        />,
      );

    renderContent("hello");
    expect(screen.getByTestId("card-a")).toHaveTextContent("hello");
  });
});
