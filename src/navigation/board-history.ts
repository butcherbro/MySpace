// Browser-style navigation history over board ids.
//
// History is session-only (Section B runtime ownership). Opening a board pushes
// the previous board; Back/Forward move without re-pushing.

export class BoardHistory {
  private stack: string[] = [];
  private index = -1;

  constructor(initial: string) {
    this.stack = [initial];
    this.index = 0;
  }

  /** The current board id. */
  current(): string {
    return this.stack[this.index];
  }

  /** Navigates to a new board, truncating any forward history. */
  push(id: string): void {
    if (this.current() === id) {
      return;
    }
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(id);
    this.index = this.stack.length - 1;
  }

  /** Returns the previous board id, or null if there is none. */
  back(): string | null {
    if (this.index <= 0) return null;
    this.index -= 1;
    return this.stack[this.index];
  }

  /** Returns the next board id, or null if there is none. */
  forward(): string | null {
    if (this.index >= this.stack.length - 1) return null;
    this.index += 1;
    return this.stack[this.index];
  }

  canBack(): boolean {
    return this.index > 0;
  }

  canForward(): boolean {
    return this.index < this.stack.length - 1;
  }
}
