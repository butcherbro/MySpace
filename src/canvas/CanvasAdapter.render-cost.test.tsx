// P1.8 budget: on a 1 000-card board, updating one card must re-render O(1)
// cards, not O(N). Uses the real React Flow (not the module mock the other
// CanvasAdapter tests use), so this also proves React Flow itself skips the
// nodes whose objects the adapter kept stable.
import { memo, Profiler } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasAdapter } from "./CanvasAdapter";
import { staleNodeIds } from "./canvas-mapping";
import type { CanvasCard } from "./canvas-types";

const N = 1000;

function makeCards(overrides: Partial<Record<string, Partial<CanvasCard>>> = {}): CanvasCard[] {
  // Fresh objects on every call, like App's per-render projection.
  return Array.from({ length: N }, (_, i) => {
    const id = `card-${i}`;
    return {
      id,
      boardId: "home",
      kind: "note",
      frame: { x: (i % 40) * 260, y: Math.floor(i / 40) * 140, width: 240, height: 120 },
      zIndex: 0,
      revision: 1,
      ...overrides[id],
    } satisfies CanvasCard;
  });
}

const renders = new Map<string, number>();
const Probe = memo(function Probe({ id, revision, editing }: { id: string; revision: number; editing: boolean }) {
  renders.set(id, (renders.get(id) ?? 0) + 1);
  return (
    <div data-testid="probe" data-editing={editing ? "true" : "false"}>
      {id}@{revision}
    </div>
  );
});

function totalRenders(): number {
  let sum = 0;
  for (const n of renders.values()) sum += n;
  return sum;
}

function setup() {
  renders.clear();
  let editingCardId: string | null = null;
  const renderCard = vi.fn((card: CanvasCard) => (
    <Probe id={card.id} revision={card.revision} editing={card.id === editingCardId} />
  ));
  let commits = 0;
  const view = (cards: CanvasCard[]) => (
    <div style={{ width: 1280, height: 800 }}>
      <Profiler id="canvas" onRender={() => void (commits += 1)}>
        <CanvasAdapter
          cards={cards}
          viewport={{ x: 0, y: 0, zoom: 1 }}
          events={{}}
          renderCard={renderCard}
          editingCardId={editingCardId}
        />
      </Profiler>
    </div>
  );
  const utils = render(view(makeCards()));
  return {
    renderCard,
    rerender(cards: CanvasCard[], nextEditing: string | null = editingCardId) {
      editingCardId = nextEditing;
      renderCard.mockClear();
      renders.clear();
      commits = 0;
      act(() => utils.rerender(view(cards)));
      return { built: renderCard.mock.calls.length, rendered: totalRenders(), commits };
    },
  };
}

describe("CanvasAdapter render cost (P1.8)", () => {
  it("renders every card once on first paint", () => {
    const { renderCard } = setup();
    expect(renderCard).toHaveBeenCalledTimes(N);
    expect(renders.size).toBe(N);
  });

  it("rebuilds and re-renders only the updated card when one of 1 000 changes", () => {
    const { rerender } = setup();
    const result = rerender(makeCards({ "card-500": { revision: 2 } }));
    expect(result.built).toBe(1);
    expect(result.rendered).toBe(1);
    expect(renders.get("card-500")).toBe(1);
  });

  it("re-renders nothing when App re-renders with an equal projection", () => {
    const { rerender } = setup();
    const result = rerender(makeCards());
    expect(result.built).toBe(0);
    expect(result.rendered).toBe(0);
  });

  it("rebuilds only the cards entering and leaving edit mode", () => {
    const { rerender } = setup();
    let result = rerender(makeCards(), "card-3");
    expect(result.built).toBe(1);
    expect(result.rendered).toBe(1);
    result = rerender(makeCards(), "card-7");
    expect(result.built).toBe(2);
    expect(result.rendered).toBe(2);
    expect(renders.has("card-3") && renders.has("card-7")).toBe(true);
  });

  it("moves one card without touching the others", () => {
    const { rerender } = setup();
    const result = rerender(
      makeCards({ "card-10": { frame: { x: 5, y: 5, width: 240, height: 120 } } }),
    );
    expect(result.built).toBe(1);
    expect(result.rendered).toBeLessThanOrEqual(1);
  });
});

describe("staleNodeIds", () => {
  const cards = makeCards().slice(0, 3);
  const base = { cards, editingCardId: null, highlightQuery: "" };

  it("is null when nothing a node depends on changed", () => {
    expect(staleNodeIds(base, { ...base, cards: cards.map((c) => ({ ...c })) })).toBeNull();
  });

  it("marks added cards and reports removals as a structural change", () => {
    const added = [...cards, { ...cards[0], id: "new" }];
    expect([...staleNodeIds(base, { ...base, cards: added })!]).toEqual(["new"]);
    const removed = staleNodeIds(base, { ...base, cards: cards.slice(1) });
    expect(removed).not.toBeNull();
    expect(removed!.size).toBe(0);
  });

  it("marks every card when the highlight query changes", () => {
    expect(staleNodeIds(base, { ...base, highlightQuery: "x" })!.size).toBe(3);
  });

  it("marks a portal whose title or cover changed", () => {
    const portal: CanvasCard = { ...cards[0], kind: "board_portal", portalTitle: "A" };
    const prev = { ...base, cards: [portal] };
    expect([...staleNodeIds(prev, { ...prev, cards: [{ ...portal, portalTitle: "B" }] })!]).toEqual([portal.id]);
  });
});
