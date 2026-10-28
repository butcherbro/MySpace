import { describe, expect, it } from "vitest";
import {
  CreateConnectorCommand,
  RemoveConnectorCommand,
  UpdateConnectorCommand,
} from "./connector-commands";
import { CommandDispatcher } from "./command-dispatcher";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import { plainTextToDocument } from "../editor/document-codec";

async function twoNotes() {
  const gateway = new MockWorkspaceGateway();
  for (const id of ["a", "b"]) {
    await gateway.createNote({
      id,
      boardId: "home",
      frame: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 0,
      documentJson: plainTextToDocument(id),
    });
  }
  return { gateway, dispatcher: new CommandDispatcher(gateway) };
}

const link = { id: "c1", boardId: "home", fromCardId: "a", toCardId: "b" };

async function connectorsOnHome(gateway: MockWorkspaceGateway) {
  return (await gateway.loadBoardSnapshot("home")).connectors;
}

describe("connector commands", () => {
  it("CreateConnectorCommand creates, undo removes, redo creates the same id again", async () => {
    const { gateway, dispatcher } = await twoNotes();
    const created = await dispatcher.execute(new CreateConnectorCommand("cmd", link));
    expect(created).toMatchObject({ id: "c1", fromCardId: "a", toCardId: "b" });

    await dispatcher.undo();
    expect(await connectorsOnHome(gateway)).toEqual([]);

    await dispatcher.redo();
    expect((await connectorsOnHome(gateway)).map((c) => c.id)).toEqual(["c1"]);
  });

  it("RemoveConnectorCommand removes, undo restores every connector with its colour, ends and label", async () => {
    const { gateway, dispatcher } = await twoNotes();
    await gateway.createConnector(link);
    const styled = await gateway.updateConnector({
      connectorId: "c1",
      expectedRevision: 1,
      colorToken: "pink",
      arrowEnds: "both",
      label: "because",
    });
    const reverse = await gateway.createConnector({ ...link, id: "c2", fromCardId: "b", toCardId: "a" });

    await dispatcher.execute(new RemoveConnectorCommand("cmd", [styled, reverse]));
    expect(await connectorsOnHome(gateway)).toEqual([]);

    await dispatcher.undo();
    const restored = await connectorsOnHome(gateway);
    expect(restored.map((c) => [c.id, c.fromCardId, c.colorToken, c.arrowEnds, c.label])).toEqual([
      ["c1", "a", "pink", "both", "because"],
      ["c2", "b", "default", "end", null],
    ]);
  });

  it("recolour, delete, undo delete, undo recolour: the revision chain survives the removal", async () => {
    const { gateway, dispatcher } = await twoNotes();
    const created = await gateway.createConnector(link);

    const recoloured = await dispatcher.execute(
      new UpdateConnectorCommand("recolour", "c1", created.revision, { colorToken: "default" }, { colorToken: "blue" }),
    );
    await dispatcher.execute(new RemoveConnectorCommand("delete", [recoloured]));
    expect(await connectorsOnHome(gateway)).toEqual([]);

    await dispatcher.undo();
    expect((await connectorsOnHome(gateway))[0]).toMatchObject({ colorToken: "blue", revision: 2 });

    await dispatcher.undo();
    expect((await connectorsOnHome(gateway))[0]).toMatchObject({ colorToken: "default", revision: 3 });
  });

  it("UpdateConnectorCommand chains revisions from the receipts through undo and redo", async () => {
    const { gateway, dispatcher } = await twoNotes();
    await gateway.createConnector(link);

    const updated = await dispatcher.execute(
      new UpdateConnectorCommand("cmd", "c1", 1, { fromCardId: "a", toCardId: "b" }, { fromCardId: "b", toCardId: "a" }),
    );
    expect(updated).toMatchObject({ fromCardId: "b", toCardId: "a", revision: 2 });

    await dispatcher.undo();
    expect((await connectorsOnHome(gateway))[0]).toMatchObject({ fromCardId: "a", revision: 3 });

    await dispatcher.redo();
    expect((await connectorsOnHome(gateway))[0]).toMatchObject({ fromCardId: "b", revision: 4 });
  });

  it("UpdateConnectorCommand undo fails as stale when the connector changed elsewhere, and leaves history", async () => {
    const { gateway, dispatcher } = await twoNotes();
    await gateway.createConnector(link);
    await dispatcher.execute(new UpdateConnectorCommand("cmd", "c1", 1, { colorToken: "default" }, { colorToken: "blue" }));
    await gateway.updateConnector({ connectorId: "c1", expectedRevision: 2, arrowEnds: "none" });

    await expect(dispatcher.undo()).rejects.toMatchObject({ code: "stale_revision" });
    expect(dispatcher.canUndo()).toBe(false);
    expect((await connectorsOnHome(gateway))[0]).toMatchObject({ colorToken: "blue", arrowEnds: "none" });
  });
});
