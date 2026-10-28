import { describe, expect, it } from "vitest";
import { CreateGroupCommand, UpdateGroupCommand } from "./group-commands";
import { CommandDispatcher } from "./command-dispatcher";
import { MoveCardsCommand } from "./card-commands";
import { CommandConflictError } from "./workspace-command";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { CardDto, GroupCardDto } from "../services/workspace-gateway";

const input = {
  id: "g1",
  boardId: "home",
  frame: { x: 40, y: 40, width: 2400, height: 600 },
  zIndex: 0,
};

async function groupOnHome(gateway: MockWorkspaceGateway): Promise<GroupCardDto | undefined> {
  const cards: CardDto[] = (await gateway.loadBoardSnapshot("home")).cards;
  return cards.find((c): c is GroupCardDto => c.kind === "group" && c.id === "g1");
}

async function created() {
  const gateway = new MockWorkspaceGateway();
  const dispatcher = new CommandDispatcher(gateway);
  const group = await dispatcher.execute(new CreateGroupCommand("create", input));
  return { gateway, dispatcher, group };
}

describe("group commands", () => {
  it("CreateGroupCommand creates a frame wider than the old 1600 px limit with defaults", async () => {
    const { gateway, group } = await created();
    expect(group).toMatchObject({ kind: "group", id: "g1", title: "", colorToken: "default", revision: 1 });
    expect((await groupOnHome(gateway))?.frame).toEqual(input.frame);
  });

  it("CreateGroupCommand undo trashes the group and redo restores the same card", async () => {
    const { gateway, dispatcher } = await created();

    await dispatcher.undo();
    expect(await groupOnHome(gateway)).toBeUndefined();

    await dispatcher.redo();
    expect(await groupOnHome(gateway)).toMatchObject({ id: "g1", frame: input.frame });
  });

  it("UpdateGroupCommand renames, and undo/redo chain the revision from each receipt", async () => {
    const { gateway, dispatcher } = await created();

    const receipt = await dispatcher.execute(
      new UpdateGroupCommand("rename", "g1", 1, { title: "" }, { title: "Идеи" }),
    );
    expect(receipt).toEqual({ id: "g1", revision: 2 });
    expect(await groupOnHome(gateway)).toMatchObject({ title: "Идеи", revision: 2 });

    await dispatcher.undo();
    expect(await groupOnHome(gateway)).toMatchObject({ title: "", revision: 3 });

    await dispatcher.redo();
    expect(await groupOnHome(gateway)).toMatchObject({ title: "Идеи", revision: 4 });
  });

  it("UpdateGroupCommand undo still works after a move bumped the revision: rename → move → undo move → undo rename", async () => {
    const { gateway, dispatcher } = await created();
    await dispatcher.execute(new UpdateGroupCommand("rename", "g1", 1, { title: "" }, { title: "Идеи" }));
    const moved = { ...input.frame, x: 300, y: 200 };
    await dispatcher.execute(
      new MoveCardsCommand("move", [{ id: "g1", revision: 2, before: input.frame, after: moved }]),
    );

    await dispatcher.undo();
    expect((await groupOnHome(gateway))?.frame).toEqual(input.frame);
    await dispatcher.undo();
    expect(await groupOnHome(gateway)).toMatchObject({ title: "", frame: input.frame });

    await dispatcher.redo();
    expect(await groupOnHome(gateway)).toMatchObject({ title: "Идеи" });
  });

  it("UpdateGroupCommand undo refuses when the title was changed elsewhere", async () => {
    const { gateway, dispatcher } = await created();
    await dispatcher.execute(new UpdateGroupCommand("rename", "g1", 1, { title: "" }, { title: "Идеи" }));
    await gateway.updateGroup({ cardId: "g1", expectedRevision: 2, title: "Чужое" });

    await expect(dispatcher.undo()).rejects.toBeInstanceOf(CommandConflictError);
    expect(await groupOnHome(gateway)).toMatchObject({ title: "Чужое" });
  });

  it("UpdateGroupCommand recolours without touching the title", async () => {
    const { gateway, dispatcher } = await created();
    await dispatcher.execute(
      new UpdateGroupCommand("color", "g1", 1, { colorToken: "default" }, { colorToken: "blue" }),
    );
    expect(await groupOnHome(gateway)).toMatchObject({ title: "", colorToken: "blue" });
  });

  it("UpdateGroupCommand refuses a stale revision", async () => {
    const { dispatcher } = await created();
    await expect(
      dispatcher.execute(new UpdateGroupCommand("stale", "g1", 7, { title: "" }, { title: "x" })),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });
});
