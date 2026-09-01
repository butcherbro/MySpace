// A serialized mutation queue that prevents optimistic writes from racing on a
// shared `revision` (Section C invariant 11 / plan runtime-ownership).
//
// Mutations for the open board run in FIFO order, so a note's blur-save can
// never overlap with a drag-move and both send the same stale `expectedRevision`.
// Each queued task reads its inputs (including the card's current revision)
// lazily, at execution time, via a caller-supplied ref.

export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueues `task` and returns a promise that resolves with its result. Tasks
   * run strictly sequentially in the order they were enqueued; a rejected task
   * does not block subsequent ones.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive even if this task rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
