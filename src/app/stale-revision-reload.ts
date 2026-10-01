import type { WorkspaceGateway } from "../services/workspace-gateway";

/** True for the `{ code: "stale_revision", message: {...} }` shape the Rust
 * `WorkspaceError::StaleRevision` variant serialises as (see
 * `src-tauri/src/domain/errors.rs`, serde tag/content). */
export function isStaleRevisionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "stale_revision"
  );
}

/**
 * Wraps the gateway so that a `stale_revision` answer to any call reloads the
 * open board once. The local copy of that card has diverged from the database
 * (for example a device sync rewrote it at a lower revision while the held
 * copy won the last merge); until the board is re-read every write to it would
 * fail the same way.
 *
 * The rejection is passed on unchanged, so the caller still shows its error
 * banner, and the failed call is not retried. While a reload runs, further
 * stale answers join it: a burst causes one reload. A stale answer after the
 * reload has settled comes from a new write and starts a new reload.
 */
// Ответы, которые вызывающий код обработал сам (повтор при stale_revision).
const handledStaleAnswers = new WeakSet<object>();

/**
 * Marks a `stale_revision` rejection as handled by its caller (it retries with
 * fresh revisions), so it does not reload the board.
 *
 * Contract: call it synchronously in the caller's own `catch`, before anything
 * that yields to a macrotask (a timer, an IPC call, an `await` on one). The
 * wrapper decides in a zero-delay timer queued when the rejection passes
 * through it; an error marked after that timer has run has already triggered
 * the reload. Awaiting other microtasks first is fine.
 */
export function markStaleRevisionHandled(err: unknown): void {
  if (typeof err === "object" && err !== null) handledStaleAnswers.add(err);
}

export function createStaleRevisionReload(gateway: WorkspaceGateway): {
  gateway: WorkspaceGateway;
  /** The open board's normal reload; until it is set, a stale answer only fails. */
  setReload: (reload: () => Promise<void>) => void;
} {
  let reload: (() => Promise<void>) | null = null;
  let reloading = false;
  const onStale = () => {
    if (reloading || !reload) return;
    reloading = true;
    // Перезагрузка сама сливает очередь записей и только потом берёт штамп
    // запроса, так что снимок новее упавшей записи и побеждает при слиянии.
    void reload()
      .catch(() => undefined)
      .finally(() => {
        reloading = false;
      });
  };

  const wrapped = new Proxy(gateway, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.catch((err: unknown) => {
          if (isStaleRevisionError(err)) {
            // Решение откладываем на задачу: к ней отказ дойдёт до catch вызывающего,
            // и тот успеет пометить его обработанным.
            setTimeout(() => {
              if (!(typeof err === "object" && err !== null && handledStaleAnswers.has(err))) onStale();
            }, 0);
          }
          throw err;
        });
      };
    },
  });
  return {
    gateway: wrapped,
    setReload(next) {
      reload = next;
    },
  };
}
