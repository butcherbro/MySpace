import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "../commands/command-dispatcher";
import { plainTextToDocument } from "../editor/document-codec";
import { MutationQueue } from "../persistence/entity-write-queue";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { CardDto } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { loadedCardWrites } from "../state/card-writes-fixture";
import { useGroupEdits } from "./use-group-edits";

async function setup() {
  const gateway = new MockWorkspaceGateway();
  await gateway.createGroup({ id: "g", boardId: "home", frame: { x: 40, y: 40, width: 600, height: 300 }, zIndex: 0 });
  await gateway.createNote({
    id: "inside",
    boardId: "home",
    frame: { x: 80, y: 100, width: 200, height: 80 },
    zIndex: 0,
    documentJson: plainTextToDocument("inside"),
  });
  const cardsRef = { current: (await gateway.loadBoardSnapshot("home")).cards as CardDto[] };
  const dispatcher = new CommandDispatcher(gateway);
  const dispatched: CurrentBoardAction[] = [];
  const dispatch = (action: CurrentBoardAction) => void dispatched.push(action);
  let counter = 0;
  const hook = renderHook(() =>
    useGroupEdits({
      gateway,
      dispatch,
      cardWrites: loadedCardWrites(cardsRef, dispatch),
      queueRef: { current: new MutationQueue() },
      cardsRef,
      dispatcher,
      idGenerator: { nextId: vi.fn(() => `id-${counter++}`) },
    }),
  );
  return { gateway, dispatcher, dispatched, hook };
}

describe("useGroupEdits", () => {
  it("resizes the frame wider than 1600 px, records an undoable resize and never moves the cards inside", async () => {
    const { gateway, dispatcher, dispatched, hook } = await setup();
    act(() => hook.result.current.handleResizeGroup("g", 2000, 200));

    await waitFor(() => expect(dispatched.some((a) => a.type === "cardMoved")).toBe(true));
    expect(dispatched.find((a) => a.type === "cardMoved")).toMatchObject({
      id: "g",
      frame: { x: 40, y: 40, width: 2000, height: 200 },
    });
    expect((await gateway.readCard("inside")).frame).toEqual({ x: 80, y: 100, width: 200, height: 80 });
    await waitFor(() => expect(dispatcher.canUndo()).toBe(true));

    await dispatcher.undo();
    expect((await gateway.readCard("g")).frame).toEqual({ x: 40, y: 40, width: 600, height: 300 });
  });

  it("an unchanged size writes nothing", async () => {
    const { gateway, dispatcher, dispatched, hook } = await setup();
    act(() => hook.result.current.handleResizeGroup("g", 600, 300));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toEqual([]);
    expect(dispatcher.canUndo()).toBe(false);
    expect(await gateway.readCard("g")).toMatchObject({ revision: 1 });
  });
});
