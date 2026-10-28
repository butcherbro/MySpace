import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "../commands/command-dispatcher";
import { plainTextToDocument } from "../editor/document-codec";
import { MutationQueue } from "../persistence/entity-write-queue";
import type { IdGenerator } from "../services/id-generator";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { BoardSummary, CardDto, GroupCardDto } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { loadedCardWrites } from "../state/card-writes-fixture";
import { GROUP_TOO_LARGE_MESSAGE, groupFrameAround, useGroupActions } from "./use-group-actions";

const home: BoardSummary = {
  id: "home",
  title: "Home",
  parentBoardId: null,
  revision: 1,
  colorToken: "ink",
  symbol: null,
  coverAsset: null,
};

function idGeneratorFixture(): IdGenerator {
  let counter = 0;
  return { nextId: vi.fn(() => `id-${counter++}`) };
}

async function setup(options: { selection?: string[]; group?: boolean } = {}) {
  const gateway = new MockWorkspaceGateway();
  await gateway.createNote({
    id: "a",
    boardId: "home",
    frame: { x: 100, y: 200, width: 240, height: 120 },
    zIndex: 0,
    documentJson: plainTextToDocument("a"),
  });
  await gateway.createNote({
    id: "b",
    boardId: "home",
    frame: { x: 500, y: 300, width: 200, height: 80 },
    zIndex: 0,
    documentJson: plainTextToDocument("b"),
  });
  if (options.group) {
    await gateway.createGroup({ id: "g", boardId: "home", frame: { x: 76, y: 140, width: 648, height: 264 }, zIndex: 0 });
  }
  const cardsRef = { current: (await gateway.loadBoardSnapshot("home")).cards as CardDto[] };
  const dispatcher = new CommandDispatcher(gateway);
  const dispatched: CurrentBoardAction[] = [];
  const dispatch = (action: CurrentBoardAction) => void dispatched.push(action);
  const cardWrites = loadedCardWrites(cardsRef, dispatch);
  const refreshTrash = vi.fn(async () => {});
  const hook = renderHook(() =>
    useGroupActions({
      board: home,
      cards: cardsRef.current,
      selection: options.selection ?? [],
      cardsRef,
      queueRef: { current: new MutationQueue() },
      dispatcher,
      idGenerator: idGeneratorFixture(),
      dispatch,
      cardWrites,
      refreshTrash,
    }),
  );
  return { gateway, dispatcher, dispatched, cardsRef, refreshTrash, hook };
}

const groupOf = (cards: CardDto[]) => cards.find((c): c is GroupCardDto => c.kind === "group");

describe("groupFrameAround", () => {
  it("is the bounding box plus 24 px on each side and 36 px more on top", () => {
    expect(
      groupFrameAround([
        { x: 100, y: 200, width: 240, height: 120 },
        { x: 500, y: 300, width: 200, height: 80 },
      ]),
    ).toEqual({ x: 76, y: 140, width: 648, height: 264 });
  });

  it("does not go past the board origin, still enclosing the cards", () => {
    expect(groupFrameAround([{ x: 10, y: 20, width: 200, height: 80 }])).toEqual({
      x: 0,
      y: 0,
      width: 234,
      height: 124,
    });
  });

  it("is null without frames", () => {
    expect(groupFrameAround([])).toBeNull();
  });
});

describe("useGroupActions", () => {
  it("groups the selection into an undoable, untitled default-colour frame at z 0", async () => {
    const { gateway, dispatcher, dispatched, hook } = await setup({ selection: ["a", "b"] });
    await act(() => hook.result.current.groupSelection());

    const added = dispatched.find((a) => a.type === "cardAdded");
    expect(added).toMatchObject({
      card: {
        kind: "group",
        boardId: "home",
        frame: { x: 76, y: 140, width: 648, height: 264 },
        zIndex: 0,
        title: "",
        colorToken: "default",
      },
    });
    expect(groupOf((await gateway.loadBoardSnapshot("home")).cards)).toBeDefined();

    await dispatcher.undo();
    expect(groupOf((await gateway.loadBoardSnapshot("home")).cards)).toBeUndefined();
  });

  it("refuses a frame larger than 8000 × 10000 with a banner and never calls the gateway", async () => {
    const { gateway, dispatched, hook, cardsRef } = await setup({ selection: ["a", "far"] });
    // Заметка далеко справа: охватывающая рамка шире 8000 px.
    await gateway.createNote({
      id: "far",
      boardId: "home",
      frame: { x: 8200, y: 200, width: 240, height: 120 },
      zIndex: 0,
      documentJson: plainTextToDocument("far"),
    });
    cardsRef.current.push(await gateway.readCard("far"));
    hook.rerender();
    const createGroup = vi.spyOn(gateway, "createGroup");

    await act(() => hook.result.current.groupSelection());

    expect(createGroup).not.toHaveBeenCalled();
    expect(dispatched).toEqual([{ type: "failed", message: GROUP_TOO_LARGE_MESSAGE }]);
  });

  it("does nothing with an empty selection", async () => {
    const { gateway, dispatched, hook } = await setup();
    await act(() => hook.result.current.groupSelection());
    expect(dispatched).toEqual([]);
    expect(groupOf((await gateway.loadBoardSnapshot("home")).cards)).toBeUndefined();
  });

  it("ungroup trashes only the frame; the cards inside keep their places", async () => {
    const { gateway, dispatched, refreshTrash, hook } = await setup({ group: true });
    await act(() => hook.result.current.ungroup(["g", "a"]));

    expect(dispatched).toEqual([{ type: "cardsRemoved", ids: ["g"] }]);
    expect(refreshTrash).toHaveBeenCalled();
    const cards = (await gateway.loadBoardSnapshot("home")).cards;
    expect(cards.map((c) => [c.id, c.frame.x, c.frame.y])).toEqual([
      ["a", 100, 200],
      ["b", 500, 300],
    ]);
  });

  it("ungroupSelection ungroups only the selected groups", async () => {
    const { dispatched, hook } = await setup({ group: true, selection: ["a", "g"] });
    await act(() => hook.result.current.ungroupSelection());
    expect(dispatched).toEqual([{ type: "cardsRemoved", ids: ["g"] }]);
  });

  it("rename stores the new title with the receipt's revision, undoably", async () => {
    const { gateway, dispatcher, dispatched, cardsRef, hook } = await setup({ group: true });
    act(() => hook.result.current.rename("g", "Идеи"));

    await waitFor(() => expect(groupOf(cardsRef.current)).toMatchObject({ title: "Идеи", revision: 2 }));
    expect(dispatched[dispatched.length - 1]).toMatchObject({ type: "cardStored", id: "g" });

    await dispatcher.undo();
    expect(await gateway.readCard("g")).toMatchObject({ title: "", revision: 3 });
  });

  it("recolor changes only the colour; the same value again writes nothing", async () => {
    const { gateway, cardsRef, hook } = await setup({ group: true });
    act(() => hook.result.current.recolor("g", "blue"));
    await waitFor(() => expect(groupOf(cardsRef.current)).toMatchObject({ colorToken: "blue", title: "" }));

    act(() => hook.result.current.recolor("g", "blue"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await gateway.readCard("g")).toMatchObject({ revision: 2 });
  });

  it("the group menu offers Rename, the seven colours and Ungroup; Rename enters editing", async () => {
    const { dispatched, cardsRef, hook } = await setup({ group: true });
    const actions = hook.result.current.groupMenuActions(groupOf(cardsRef.current)!);
    expect(actions.map((a) => a.label)).toEqual([
      "Rename",
      "Default",
      "Yellow",
      "Pink",
      "Lavender",
      "Blue",
      "Green",
      "Gray",
      "Ungroup",
    ]);

    act(() => actions[0].onSelect());
    expect(dispatched).toEqual([{ type: "editingStarted", id: "g" }]);
  });
});
