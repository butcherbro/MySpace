import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGateway } from "../services/workspace-gateway";
import { createStaleRevisionReload, markStaleRevisionHandled } from "./stale-revision-reload";

const stale = { code: "stale_revision", message: { expected: 8, actual: 3 } };
/** Lets the deferred reload decision run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A promise the test settles by hand. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(moveCard: () => Promise<unknown>) {
  const reloads: Array<ReturnType<typeof deferred>> = [];
  const reload = vi.fn(() => {
    const next = deferred();
    reloads.push(next);
    return next.promise;
  });
  const raw = { moveCard: vi.fn(moveCard), readCard: vi.fn(async () => null) };
  const { gateway, setReload } = createStaleRevisionReload(raw as unknown as WorkspaceGateway);
  setReload(reload);
  return { raw, gateway, reload, reloads };
}

describe("createStaleRevisionReload", () => {
  it("reloads once and passes the same error on, so the write still shows its banner", async () => {
    const test = harness(async () => {
      throw stale;
    });

    await expect(test.gateway.moveCard({ id: "a", expectedRevision: 8, frame: { x: 0, y: 0, width: 1, height: 1 } }))
      .rejects.toBe(stale);
    await settle();

    expect(test.reload).toHaveBeenCalledTimes(1);
    // Упавшую запись сам не повторяет.
    expect(test.raw.moveCard).toHaveBeenCalledTimes(1);
  });

  it("turns a burst of stale answers into one reload", async () => {
    const test = harness(async () => {
      throw stale;
    });
    const frame = { x: 0, y: 0, width: 1, height: 1 };

    await Promise.allSettled([
      test.gateway.moveCard({ id: "a", expectedRevision: 8, frame }),
      test.gateway.moveCard({ id: "b", expectedRevision: 2, frame }),
      test.gateway.moveCard({ id: "c", expectedRevision: 5, frame }),
    ]);
    // Ещё один устаревший ответ, пока перезагрузка идёт.
    await test.gateway.moveCard({ id: "d", expectedRevision: 1, frame }).catch(() => undefined);
    await settle();

    expect(test.reload).toHaveBeenCalledTimes(1);
  });

  it("treats a stale answer after the reload settled as a new event", async () => {
    const test = harness(async () => {
      throw stale;
    });
    const frame = { x: 0, y: 0, width: 1, height: 1 };

    await test.gateway.moveCard({ id: "a", expectedRevision: 8, frame }).catch(() => undefined);
    await settle();
    test.reloads[0].resolve();
    await test.reloads[0].promise;
    await Promise.resolve();
    await test.gateway.moveCard({ id: "a", expectedRevision: 3, frame }).catch(() => undefined);
    await settle();

    expect(test.reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload for a stale answer its caller marks as handled", async () => {
    const test = harness(async () => {
      throw stale;
    });

    await test.gateway
      .moveCard({ id: "a", expectedRevision: 8, frame: { x: 0, y: 0, width: 1, height: 1 } })
      .catch((err: unknown) => markStaleRevisionHandled(err));
    await settle();

    expect(test.reload).not.toHaveBeenCalled();
  });

  it("does not reload for other failures or for successful calls", async () => {
    const other = harness(async () => {
      throw { code: "not_found", message: "a" };
    });
    await other.gateway.moveCard({ id: "a", expectedRevision: 1, frame: { x: 0, y: 0, width: 1, height: 1 } })
      .catch(() => undefined);
    await settle();
    expect(other.reload).not.toHaveBeenCalled();

    const ok = harness(async () => ({ id: "a", revision: 2 }));
    await expect(ok.gateway.readCard("a")).resolves.toBeNull();
    await ok.gateway.moveCard({ id: "a", expectedRevision: 1, frame: { x: 0, y: 0, width: 1, height: 1 } });
    expect(ok.reload).not.toHaveBeenCalled();
  });
});
