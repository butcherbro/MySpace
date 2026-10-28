import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "../commands/command-dispatcher";
import { TrashSelectionCommand } from "../commands/trash-commands";
import { plainTextToDocument } from "../editor/document-codec";
import type { IdGenerator } from "../services/id-generator";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { BoardSummary, ConnectorDto } from "../services/workspace-gateway";
import type { CurrentBoardAction } from "../state/current-board-store";
import { loadedCardWrites } from "../state/card-writes-fixture";
import { useConnectorActions } from "./use-connector-actions";

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

async function setup(connectors: ConnectorDto[] = []) {
  const gateway = new MockWorkspaceGateway();
  for (const id of ["a", "b", "c"]) {
    await gateway.createNote({
      id,
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 0,
      documentJson: plainTextToDocument(id),
    });
  }
  for (const c of connectors) await gateway.createConnector(c);
  const dispatcher = new CommandDispatcher(gateway);
  const dispatched: CurrentBoardAction[] = [];
  const dispatch = (action: CurrentBoardAction) => void dispatched.push(action);
  const cardWrites = loadedCardWrites({ current: [] }, dispatch);
  const hook = renderHook(
    (props: { connectors: ConnectorDto[] }) =>
      useConnectorActions({
        board: home,
        connectors: props.connectors,
        dispatcher,
        idGenerator: idGeneratorFixture(),
        dispatch,
        cardWrites,
      }),
    { initialProps: { connectors } },
  );
  return { gateway, dispatcher, dispatched, hook };
}

const stored: ConnectorDto = {
  id: "c1",
  boardId: "home",
  fromCardId: "a",
  toCardId: "b",
  colorToken: "default",
  arrowEnds: "end",
  label: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

describe("useConnectorActions", () => {
  it("creates an undoable connector on the open board and adds it to the store", async () => {
    const { gateway, dispatcher, dispatched, hook } = await setup();
    act(() => hook.result.current.handleConnectorCreate({ fromCardId: "a", toCardId: "b" }));

    await waitFor(() => expect(dispatched.some((a) => a.type === "connectorCreated")).toBe(true));
    const created = dispatched.find((a) => a.type === "connectorCreated");
    expect(created).toMatchObject({ connector: { boardId: "home", fromCardId: "a", toCardId: "b" } });
    expect(dispatcher.canUndo()).toBe(true);
    expect((await gateway.loadBoardSnapshot("home")).connectors).toHaveLength(1);
  });

  it("Delete removes only the selected connectors, and does nothing without a selection", async () => {
    const { gateway, dispatched, hook } = await setup([stored]);
    await act(() => hook.result.current.handleDeleteKey([], async () => {}));
    expect(dispatched).toEqual([]);

    act(() => hook.result.current.handleConnectorSelectionChanged({ ids: ["c1"] }));
    await act(() => hook.result.current.handleDeleteKey([], async () => {}));
    expect(dispatched).toEqual([{ type: "connectorsRemoved", ids: ["c1"] }]);
    expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);
  });

  it("Delete with cards selected too removes the other connectors first, then trashes, skipping the cascaded ones", async () => {
    const other: ConnectorDto = { ...stored, id: "c2", fromCardId: "b", toCardId: "c" };
    const { gateway, dispatcher, dispatched, hook } = await setup([stored, other]);
    act(() => hook.result.current.handleConnectorSelectionChanged({ ids: ["c1", "c2"] }));

    const order: string[] = [];
    const trashCards = async () => {
      order.push(`trash after ${dispatched.map((a) => a.type).join(",")}`);
      await dispatcher.execute(new TrashSelectionCommand("trash", [{ id: "a", kind: "note" }]));
    };
    await act(() => hook.result.current.handleDeleteKey(["a"], trashCards));

    // c1 касается удаляемой карточки «a» — его снимает каскад корзины, не отдельная команда.
    expect(dispatched).toEqual([{ type: "connectorsRemoved", ids: ["c2"] }]);
    expect(order).toEqual(["trash after connectorsRemoved"]);
    expect((await gateway.loadBoardSnapshot("home")).connectors).toEqual([]);

    // Первый undo возвращает корзину (вместе с c1), второй — c2.
    await dispatcher.undo();
    expect((await gateway.loadBoardSnapshot("home")).connectors.map((c) => c.id)).toEqual(["c1"]);
    await dispatcher.undo();
    expect((await gateway.loadBoardSnapshot("home")).connectors.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("drops a second Delete while the first is in flight: one removal, one trash", async () => {
    const other: ConnectorDto = { ...stored, id: "c2", fromCardId: "b", toCardId: "c" };
    const { dispatcher, dispatched, hook } = await setup([stored, other]);
    act(() => hook.result.current.handleConnectorSelectionChanged({ ids: ["c2"] }));
    const trashCards = vi.fn(() => dispatcher.execute(new TrashSelectionCommand("trash", [{ id: "a", kind: "note" }])));

    await act(async () => {
      const first = hook.result.current.handleDeleteKey(["a"], trashCards);
      const second = hook.result.current.handleDeleteKey(["a"], trashCards);
      await Promise.all([first, second]);
    });

    expect(dispatched.filter((a) => a.type === "connectorsRemoved")).toEqual([{ type: "connectorsRemoved", ids: ["c2"] }]);
    expect(trashCards).toHaveBeenCalledTimes(1);
  });

  it("offers colours, arrow ends, reverse and delete in the context menu", async () => {
    const { hook } = await setup([stored]);
    act(() => hook.result.current.handleConnectorContextMenu("c1", 10, 20));
    expect(hook.result.current.connectorMenu).toEqual({ connectorId: "c1", x: 10, y: 20 });
    expect(hook.result.current.connectorMenuActions.map((a) => a.label)).toEqual([
      "Default",
      "Yellow",
      "Pink",
      "Lavender",
      "Blue",
      "Green",
      "Gray",
      "Arrow at end",
      "Arrows both ends",
      "No arrows",
      "Reverse direction",
      "Delete connector",
    ]);
  });

  it("menu updates carry the held revision, and choosing the current value writes nothing", async () => {
    const { dispatcher, dispatched, hook } = await setup([stored]);
    act(() => hook.result.current.handleConnectorContextMenu("c1", 0, 0));
    const action = (id: string) => hook.result.current.connectorMenuActions.find((a) => a.id === id)!;

    act(() => action("arrow-end").onSelect());
    expect(dispatcher.canUndo()).toBe(false);

    act(() => action("reverse").onSelect());
    await waitFor(() => expect(dispatched.some((a) => a.type === "connectorUpdated")).toBe(true));
    expect(dispatched.find((a) => a.type === "connectorUpdated")).toMatchObject({
      connector: { fromCardId: "b", toCardId: "a", revision: 2 },
    });
  });
});
