import { describe, expect, it } from "vitest";
import { MutationQueue } from "./entity-write-queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("MutationQueue", () => {
  it("runs tasks in FIFO order", async () => {
    const q = new MutationQueue();
    const order: string[] = [];

    const p1 = q.run(async () => {
      await sleep(20);
      order.push("a");
    });
    const p2 = q.run(async () => {
      order.push("b");
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(["a", "b"]);
  });

  it("does not block later tasks on a rejection", async () => {
    const q = new MutationQueue();
    const order: string[] = [];

    const p1 = q.run(async () => {
      order.push("fail");
      throw new Error("boom");
    });
    const p2 = q.run(async () => {
      order.push("ok");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(order).toEqual(["fail", "ok"]);
  });

  it("resolves the task result value", async () => {
    const q = new MutationQueue();
    const result = await q.run(async () => 42);
    expect(result).toBe(42);
  });
});
