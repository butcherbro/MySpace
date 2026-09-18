import { describe, expect, it } from "vitest";
import {
  buildPasteSpecs,
  clearCardClipboard,
  readCardClipboard,
  setCardClipboard,
  type CopiedCard,
} from "./card-clipboard";

const asset = {
  id: "asset-shared-1",
  fileName: "cover.png",
  mimeType: "image/png",
  width: 400,
  height: 300,
  sizeBytes: 1234,
  filePath: "asset-shared-1.png",
};

describe("card clipboard buffer", () => {
  it("starts empty", () => {
    clearCardClipboard();
    expect(readCardClipboard()).toBeNull();
  });

  it("setCardClipboard([]) clears the buffer (nothing worth pasting)", () => {
    setCardClipboard([{ kind: "note", dx: 0, dy: 0, width: 1, height: 1, documentJson: {}, plainText: "", colorToken: "default" }]);
    setCardClipboard([]);
    expect(readCardClipboard()).toBeNull();
  });

  it("round-trips whatever was copied", () => {
    const cards: CopiedCard[] = [
      { kind: "note", dx: 0, dy: 0, width: 240, height: 120, documentJson: { a: 1 }, plainText: "hi", colorToken: "yellow" },
    ];
    setCardClipboard(cards);
    expect(readCardClipboard()).toEqual(cards);
  });
});

describe("buildPasteSpecs", () => {
  function makeIdGen() {
    let n = 0;
    return () => `new-${++n}`;
  }

  it("places a single card exactly at the cursor", () => {
    const copied: CopiedCard[] = [
      { kind: "note", dx: 0, dy: 0, width: 240, height: 120, documentJson: { a: 1 }, plainText: "hi", colorToken: "default" },
    ];
    const [spec] = buildPasteSpecs(copied, { x: 500, y: 300 }, "board-b", 3, makeIdGen());
    expect(spec).toEqual({
      kind: "note",
      id: "new-1",
      boardId: "board-b",
      frame: { x: 500, y: 300, width: 240, height: 120 },
      zIndex: 3,
      documentJson: { a: 1 },
      plainText: "hi",
      colorToken: "default",
    });
  });

  it("preserves the relative layout of a multi-card copy: the group's top-left lands at the cursor", () => {
    // Two cards copied together: note at (100,100), image at (340,180) — dx/dy
    // recorded relative to the group's top-left (100,100).
    const copied: CopiedCard[] = [
      { kind: "note", dx: 0, dy: 0, width: 240, height: 120, documentJson: {}, plainText: "", colorToken: "default" },
      { kind: "image", dx: 240, dy: 80, width: 200, height: 150, asset, captionJson: {}, captionPlainText: "" },
    ];
    const specs = buildPasteSpecs(copied, { x: 1000, y: 1000 }, "board-a", 0, makeIdGen());
    expect(specs[0].frame).toEqual({ x: 1000, y: 1000, width: 240, height: 120 });
    expect(specs[1].frame).toEqual({ x: 1240, y: 1080, width: 200, height: 150 });
    // Same relative offset between them as the source (240, 80).
    expect(specs[1].frame.x - specs[0].frame.x).toBe(240);
    expect(specs[1].frame.y - specs[0].frame.y).toBe(80);
  });

  it("an image spec reuses the copied card's asset id (copy-in model)", () => {
    const copied: CopiedCard[] = [
      { kind: "image", dx: 0, dy: 0, width: 200, height: 150, asset, captionJson: {}, captionPlainText: "cap" },
    ];
    const [spec] = buildPasteSpecs(copied, { x: 0, y: 0 }, "board-a", 0, makeIdGen());
    expect(spec.kind).toBe("image");
    expect((spec as { assetId: string }).assetId).toBe("asset-shared-1");
  });

  it("assigns increasing zIndex from the given base, and pastes onto whatever boardId is passed (a different board than the source)", () => {
    const copied: CopiedCard[] = [
      { kind: "note", dx: 0, dy: 0, width: 240, height: 120, documentJson: {}, plainText: "", colorToken: "default" },
      { kind: "image", dx: 10, dy: 10, width: 200, height: 150, asset, captionJson: {}, captionPlainText: "" },
    ];
    const specs = buildPasteSpecs(copied, { x: 0, y: 0 }, "board-other", 5, makeIdGen());
    expect(specs.map((s) => s.zIndex)).toEqual([5, 6]);
    expect(specs.every((s) => s.boardId === "board-other")).toBe(true);
  });
});
