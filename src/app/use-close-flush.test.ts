import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCloseFlush, type CloseFlushOptions } from "./use-close-flush";

type Invoke = ReturnType<typeof vi.fn>;

/**
 * Builds the hook deps with a controllable close listener. `fireClose` invokes
 * the handler the hook registered, exactly as the window close event would.
 * Tests simulate the packaged window unless they say otherwise.
 */
function harness(overrides: Partial<CloseFlushOptions> = {}) {
  let handle: (() => void) | null = null;
  const unlisten = vi.fn();
  const listenClose = vi.fn(async (handler: () => void) => {
    handle = handler;
    return unlisten;
  });

  const flushes = [vi.fn(async () => {}), vi.fn(async () => {})];
  const close = vi.fn(async () => {});
  const confirmAbandon = vi.fn(async () => true);
  const onError = vi.fn();

  const options: CloseFlushOptions = {
    flushes,
    close,
    confirmAbandon,
    onError,
    listenClose,
    enabled: true,
    ...overrides,
  };

  const rendered = renderHook(() => useCloseFlush(options));
  return {
    ...rendered,
    // The effective deps, so an override is what the assertions see.
    flushes: options.flushes,
    close: options.close,
    confirmAbandon: options.confirmAbandon,
    onError: options.onError as Invoke,
    listenClose: options.listenClose as Invoke,
    unlisten,
    fireClose: async () => {
      await waitFor(() => expect(handle).not.toBeNull());
      await act(async () => {
        handle?.();
      });
    },
  };
}

describe("useCloseFlush", () => {
  it("closes only after every queue has flushed", async () => {
    // The defect: closing within the 250 ms draft debounce dropped the last
    // keystrokes. The close must not happen before both barriers settle.
    const order: string[] = [];
    const first = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("drafts");
    });
    const second = vi.fn(async () => {
      order.push("viewport");
    });
    const close = vi.fn(async () => {
      order.push("close");
    });

    const test = harness({ flushes: [first, second], close });
    await test.fireClose();

    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["viewport", "drafts", "close"]);
  });

  it("closes immediately when there is nothing pending", async () => {
    const test = harness();
    await test.fireClose();

    await waitFor(() => expect(test.close).toHaveBeenCalledTimes(1));
    expect(test.confirmAbandon).not.toHaveBeenCalled();
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("asks before abandoning when a queue fails", async () => {
    const failing = vi.fn<() => Promise<void>>(async () => {
      throw new Error("backend unavailable");
    });
    const test = harness({ flushes: [failing], confirmAbandon: vi.fn(async () => true) });
    await test.fireClose();

    await waitFor(() => expect(test.confirmAbandon).toHaveBeenCalledTimes(1));
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it("stays open when the user refuses to abandon, and a later close retries", async () => {
    const failing = vi.fn<() => Promise<void>>(async () => {
      throw new Error("backend unavailable");
    });
    const confirmAbandon = vi.fn(async () => false);
    const test = harness({ flushes: [failing], confirmAbandon });

    await test.fireClose();
    await waitFor(() => expect(confirmAbandon).toHaveBeenCalledTimes(1));
    expect(test.close).not.toHaveBeenCalled();
    expect(test.onError).toHaveBeenCalledTimes(1);

    // The user fixed nothing but insists again: this is a fresh attempt, not a
    // replay of the old refusal.
    failing.mockImplementation(async () => {});
    await test.fireClose();
    await waitFor(() => expect(test.close).toHaveBeenCalledTimes(1));
    expect(confirmAbandon).toHaveBeenCalledTimes(1);
  });

  it("treats a flush that never settles as a failure after the timeout", async () => {
    const stuck = vi.fn(() => new Promise<void>(() => {}));
    const confirmAbandon = vi.fn(async () => true);
    const test = harness({ flushes: [stuck], confirmAbandon, timeoutMs: 10 });

    await test.fireClose();

    await waitFor(() => expect(confirmAbandon).toHaveBeenCalledTimes(1));
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it("treats a second close request as 'do not wait'", async () => {
    // A user who presses Cmd+Q twice is insisting; the second request must not
    // start another flush and must not stop a failing attempt from closing.
    let release: (() => void) | null = null;
    const slow = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          release = () => reject(new Error("still failing"));
        }),
    );
    const confirmAbandon = vi.fn(async () => false);
    const test = harness({ flushes: [slow], confirmAbandon, timeoutMs: 5000 });

    await test.fireClose();
    await test.fireClose();
    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(test.close).toHaveBeenCalledTimes(1));
    expect(slow).toHaveBeenCalledTimes(1);
    expect(confirmAbandon).not.toHaveBeenCalled();
  });

  it("reports a close that fails and does not try again on its own", async () => {
    const close = vi.fn(async () => {
      throw new Error("destroy denied");
    });
    const test = harness({ close });
    await test.fireClose();

    await waitFor(() => expect(test.onError).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("removes the close listener on unmount", async () => {
    const test = harness();
    await waitFor(() => expect(test.listenClose).toHaveBeenCalledTimes(1));
    test.unmount();
    expect(test.unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not intercept the close when there is no Tauri window", async () => {
    // A plain browser cannot delay its own close; the hook must not pretend to.
    const test = harness({ enabled: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(test.listenClose).not.toHaveBeenCalled();
    expect(test.close).not.toHaveBeenCalled();
  });
});
