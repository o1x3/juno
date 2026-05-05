// Ported verbatim from pi-mono's `packages/tui/src/undo-stack.ts`.
// Generic undo stack with structuredClone snapshots.

export class UndoStack<S> {
  private stack: S[] = [];

  /** Push a deep clone of the given state. */
  push(state: S): void {
    this.stack.push(structuredClone(state));
  }

  /** Pop and return the most recent snapshot, or undefined if empty. */
  pop(): S | undefined {
    return this.stack.pop();
  }

  clear(): void {
    this.stack.length = 0;
  }

  get length(): number {
    return this.stack.length;
  }
}
