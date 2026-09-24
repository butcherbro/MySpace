import { describe, expect, it } from "vitest";
import { shouldReload, type ChangeSample } from "./external-change-detector";

const sample = (dataVersion: number, changeSeq: number, boardId = "b1"): ChangeSample => ({
  boardId,
  dataVersion,
  changeSeq,
});

describe("shouldReload", () => {
  it("does nothing on the first sample", () => {
    expect(shouldReload(null, sample(5, 3))).toEqual({ reloadBoard: false, refreshTrash: false });
  });

  it("does nothing for an own write (dataVersion unchanged, changeSeq moved)", () => {
    expect(shouldReload(sample(5, 3), sample(5, 4))).toEqual({
      reloadBoard: false,
      refreshTrash: false,
    });
  });

  it("does nothing when nothing changed", () => {
    expect(shouldReload(sample(5, 3), sample(5, 3))).toEqual({
      reloadBoard: false,
      refreshTrash: false,
    });
  });

  it("refreshes only the trash for an external write to another board", () => {
    expect(shouldReload(sample(5, 3), sample(6, 3))).toEqual({
      reloadBoard: false,
      refreshTrash: true,
    });
  });

  it("reloads the board and the trash for an external write to the open board", () => {
    expect(shouldReload(sample(5, 3), sample(6, 4))).toEqual({
      reloadBoard: true,
      refreshTrash: true,
    });
  });

  it("only re-primes on a board switch", () => {
    expect(shouldReload(sample(5, 3, "b1"), sample(9, 1, "b2"))).toEqual({
      reloadBoard: false,
      refreshTrash: false,
    });
  });
});
