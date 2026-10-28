import { describe, expect, it } from "vitest";
import { connectorEndpoints, type ConnectorSegment } from "./connector-geometry";

/** Точно — с поправкой на округление параметра обрезки. */
function expectSegment(segment: ConnectorSegment | null, [x1, y1, x2, y2]: number[]) {
  expect(segment).not.toBeNull();
  expect(segment!.x1).toBeCloseTo(x1, 6);
  expect(segment!.y1).toBeCloseTo(y1, 6);
  expect(segment!.x2).toBeCloseTo(x2, 6);
  expect(segment!.y2).toBeCloseTo(y2, 6);
}

describe("connectorEndpoints", () => {
  it("joins horizontal neighbours from the right edge to the left edge", () => {
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 100, height: 50 }, { x: 200, y: 0, width: 100, height: 50 }),
    ).toEqual({ x1: 100, y1: 25, x2: 200, y2: 25 });
  });

  it("points back the other way when the target is on the left", () => {
    expect(
      connectorEndpoints({ x: 200, y: 0, width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 }),
    ).toEqual({ x1: 200, y1: 25, x2: 100, y2: 25 });
  });

  it("joins vertical neighbours from the bottom edge to the top edge", () => {
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 100, height: 50 }, { x: 0, y: 150, width: 100, height: 50 }),
    ).toEqual({ x1: 50, y1: 50, x2: 50, y2: 150 });
  });

  it("clips a diagonal line at the border it actually crosses", () => {
    // Центры (50,50) и (250,350): линия круче диагонали, выходит через низ и входит через верх.
    const segment = connectorEndpoints(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 200, y: 300, width: 100, height: 100 },
    );
    expectSegment(segment, [50 + 200 / 6, 100, 250 - 200 / 6, 300]);
  });

  it("clips a shallow diagonal at the side borders", () => {
    // Центры (60,40) и (360,140): наклон 1/3, линия выходит через правую сторону.
    const segment = connectorEndpoints(
      { x: 0, y: 0, width: 120, height: 80 },
      { x: 300, y: 100, width: 120, height: 80 },
    );
    expectSegment(segment, [120, 60, 300, 120]);
  });

  it("is null for a card nested inside the other", () => {
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 300, height: 300 }, { x: 100, y: 100, width: 50, height: 50 }),
    ).toBeNull();
  });

  it("is null for overlapping and for touching cards", () => {
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 0, width: 100, height: 100 }),
    ).toBeNull();
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 100, height: 50 }, { x: 100, y: 0, width: 100, height: 50 }),
    ).toBeNull();
  });

  it("is null when the centres coincide", () => {
    expect(
      connectorEndpoints({ x: 0, y: 0, width: 100, height: 100 }, { x: 25, y: 25, width: 50, height: 50 }),
    ).toBeNull();
  });
});
