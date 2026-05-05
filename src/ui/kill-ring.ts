// Ported verbatim from pi-mono's `packages/tui/src/kill-ring.ts`.
// Ring buffer for emacs-style kill/yank operations.

export class KillRing {
  private ring: string[] = [];

  /**
   * Add text to the kill ring.
   *
   * @param opts.prepend - If accumulating, prepend (backward deletion) or
   *   append (forward deletion).
   * @param opts.accumulate - Merge with the most recent entry instead of
   *   creating a new one (used for consecutive kills).
   */
  push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
    if (!text) return;

    if (opts.accumulate && this.ring.length > 0) {
      const last = this.ring.pop() ?? '';
      this.ring.push(opts.prepend ? text + last : last + text);
    } else {
      this.ring.push(text);
    }
  }

  /** Most recent entry without modifying the ring. */
  peek(): string | undefined {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
  }

  /** Move last entry to front, for yank-pop cycling. */
  rotate(): void {
    if (this.ring.length > 1) {
      const last = this.ring.pop() ?? '';
      this.ring.unshift(last);
    }
  }

  get length(): number {
    return this.ring.length;
  }
}
