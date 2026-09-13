import { useEffect, useRef } from "react";

/**
 * Close-flush contract for the desktop window.
 *
 * Pending drafts are written on a 250 ms debounce and the viewport has its own
 * debounce, so closing the window inside that window lost the last edit: React
 * never unmounts on close, and nothing intercepted the close. This hook takes
 * ownership of the close, waits for every pending-write barrier, and only then
 * lets the window go.
 *
 * The queues themselves are untouched: they are passed in as `flushes` and run
 * concurrently, so each keeps its own owner and its own semantics.
 */

/** How long a close waits for pending writes before asking the user. */
export const CLOSE_FLUSH_TIMEOUT_MS = 2000;

export interface CloseFlushOptions {
  /** Every pending-write barrier that must settle before the window closes. */
  flushes: ReadonlyArray<() => Promise<void>>;
  /** Closes the window for real, once the flush settled or was abandoned. */
  close: () => Promise<void>;
  /** Asks whether to close without saving. `true` closes. */
  confirmAbandon: () => Promise<boolean>;
  /** Surfaces a failed flush the user chose to stay for, or a failed close. */
  onError?: (error: unknown) => void;
  /** Registers a close-request listener. Overridable for tests. */
  listenClose?: (handler: () => void) => Promise<() => void>;
  timeoutMs?: number;
  /** `false` in a plain browser, where a close cannot be delayed. */
  enabled?: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Default listener: the Tauri window close request, taken over by us. */
async function listenTauriClose(handler: () => void): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    handler();
  });
}

/** Default close: destroy the window, never `close()` (that would re-enter us). */
export async function destroyWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

export async function confirmAbandonWithDialog(): Promise<boolean> {
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask("Your last changes could not be saved. Close without saving?", {
    title: "MySpace",
    kind: "warning",
    okLabel: "Close without saving",
    cancelLabel: "Stay",
  });
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("closing waited too long for pending writes")),
      timeoutMs,
    );
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runClose(
  deps: CloseFlushOptions,
  forceClose: { current: boolean },
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? CLOSE_FLUSH_TIMEOUT_MS;
  try {
    const pending = Promise.all(deps.flushes.map((flush) => flush())).then(() => undefined);
    await withTimeout(pending, timeoutMs);
  } catch (error) {
    // A second close request while this one is running means "do not wait":
    // the user insisted, so they get the close rather than a question.
    if (!forceClose.current) {
      const abandon = await deps.confirmAbandon().catch(() => true);
      if (!abandon) {
        deps.onError?.(error);
        return;
      }
    }
  }

  try {
    await deps.close();
  } catch (error) {
    deps.onError?.(error);
  }
}

export function useCloseFlush(options: CloseFlushOptions): void {
  // Deps are read through a ref so the returned behaviour stays stable while
  // always seeing the current queues (the callers rebuild the array each render).
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const enabled = options.enabled ?? isTauriRuntime();

  // Single-flight: one flush at a time, and a repeated request only marks that
  // the close must not wait for a failing attempt.
  const flushing = useRef<Promise<void> | null>(null);
  const forceClose = useRef(false);
  const request = useRef(async (): Promise<void> => {
    if (flushing.current !== null) {
      forceClose.current = true;
      await flushing.current;
      return;
    }
    forceClose.current = false;
    const attempt = runClose(latest.current, forceClose);
    flushing.current = attempt;
    try {
      await attempt;
    } finally {
      flushing.current = null;
    }
  });

  useEffect(() => {
    if (!enabled) {
      // A browser cannot delay its own close, and an unload cannot be awaited:
      // flush best-effort so a dev session loses as little as possible.
      const handler = () => {
        for (const flush of latest.current.flushes) {
          void flush().catch(() => {});
        }
      };
      window.addEventListener("pagehide", handler);
      return () => window.removeEventListener("pagehide", handler);
    }

    let unlisten: (() => void) | null = null;
    let disposed = false;
    const listen = latest.current.listenClose ?? listenTauriClose;
    void listen(() => {
      void request.current();
    }).then(
      (remove) => {
        if (disposed) remove();
        else unlisten = remove;
      },
      (error: unknown) => latest.current.onError?.(error),
    );

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [enabled]);
}
