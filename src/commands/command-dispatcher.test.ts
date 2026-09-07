import { describe, expect, it, vi } from "vitest";
import { CommandDispatcher } from "./command-dispatcher";
import { MockWorkspaceGateway } from "../services/mock-workspace-gateway";
import type { WorkspaceCommand } from "./workspace-command";
import type { WorkspaceGateway } from "../services/workspace-gateway";

function cmd(
  id: string,
  label: string,
  exec: (g: WorkspaceGateway) => Promise<void>,
  undo: (g: WorkspaceGateway) => Promise<void>,
): WorkspaceCommand {
  return { id, label, execute: exec, undo };
}

describe("CommandDispatcher", () => {
  it("notifies subscribers after successful history changes", async () => {
    const d = new CommandDispatcher(new MockWorkspaceGateway());
    const listener = vi.fn();
    const unsubscribe = d.subscribe(listener);
    const command = cmd("a", "A", async () => {}, async () => {});

    await d.execute(command);
    await d.undo();
    await d.redo();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    await d.execute(cmd("b", "B", async () => {}, async () => {}));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not notify subscribers when command execution fails", async () => {
    const d = new CommandDispatcher(new MockWorkspaceGateway());
    const listener = vi.fn();
    d.subscribe(listener);

    await expect(
      d.execute(cmd("f", "F", async () => { throw new Error("boom"); }, async () => {})),
    ).rejects.toThrow("boom");
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps history intact when undo or redo fails", async () => {
    const d = new CommandDispatcher(new MockWorkspaceGateway());
    let failUndo = true;
    let failRedo = false;
    const command = cmd(
      "a",
      "A",
      async () => {
        if (failRedo) throw new Error("redo failed");
      },
      async () => {
        if (failUndo) throw new Error("undo failed");
      },
    );

    await d.execute(command);
    await expect(d.undo()).rejects.toThrow("undo failed");
    expect(d.canUndo()).toBe(true);
    expect(d.canRedo()).toBe(false);

    failUndo = false;
    await d.undo();
    failRedo = true;
    await expect(d.redo()).rejects.toThrow("redo failed");
    expect(d.canUndo()).toBe(false);
    expect(d.canRedo()).toBe(true);
  });

  it("serializes overlapping history operations", async () => {
    const d = new CommandDispatcher(new MockWorkspaceGateway());
    let releaseUndo!: () => void;
    const undoGate = new Promise<void>((resolve) => { releaseUndo = resolve; });
    const undo = vi.fn(async () => { await undoGate; });
    await d.execute(cmd("a", "A", async () => {}, undo));

    const first = d.undo();
    const second = d.undo();
    await Promise.resolve();
    expect(undo).toHaveBeenCalledTimes(1);

    releaseUndo();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("executes a command and makes it undoable", async () => {
    const gw = new MockWorkspaceGateway();
    const d = new CommandDispatcher(gw);
    const order: string[] = [];

    await d.execute(cmd("a", "A", async () => { order.push("exec-a"); }, async () => { order.push("undo-a"); }));
    expect(d.canUndo()).toBe(true);
    await d.undo();
    expect(order).toEqual(["exec-a", "undo-a"]);
  });

  it("does not record a failed command", async () => {
    const gw = new MockWorkspaceGateway();
    const d = new CommandDispatcher(gw);

    await expect(
      d.execute(
        cmd("f", "F", async () => {
          throw new Error("boom");
        }, async () => {}),
      ),
    ).rejects.toThrow("boom");

    expect(d.canUndo()).toBe(false);
  });

  it("clears redo after a new command", async () => {
    const gw = new MockWorkspaceGateway();
    const d = new CommandDispatcher(gw);
    const log: string[] = [];

    await d.execute(cmd("1", "One", async () => { log.push("e1"); }, async () => { log.push("u1"); }));
    await d.execute(cmd("2", "Two", async () => { log.push("e2"); }, async () => { log.push("u2"); }));
    await d.undo(); // -> e1
    expect(d.canRedo()).toBe(true);

    await d.execute(cmd("3", "Three", async () => { log.push("e3"); }, async () => { log.push("u3"); }));
    expect(d.canRedo()).toBe(false);
  });

  it("undo then redo re-executes", async () => {
    const gw = new MockWorkspaceGateway();
    const d = new CommandDispatcher(gw);
    const log: string[] = [];

    await d.execute(cmd("1", "One", async () => { log.push("e1"); }, async () => { log.push("u1"); }));
    await d.undo();
    await d.redo();
    expect(log).toEqual(["e1", "u1", "e1"]);
  });
});
