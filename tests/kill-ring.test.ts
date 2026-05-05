import { describe, expect, test } from 'bun:test';

import { KillRing } from '@/ui/kill-ring';

describe('KillRing', () => {
  test('peek on empty ring returns undefined', () => {
    const r = new KillRing();
    expect(r.peek()).toBeUndefined();
    expect(r.length).toBe(0);
  });

  test('push appends entries and peek returns the most recent', () => {
    const r = new KillRing();
    r.push('first', { prepend: false });
    r.push('second', { prepend: false });
    expect(r.length).toBe(2);
    expect(r.peek()).toBe('second');
  });

  test('accumulate prepend joins to the most recent entry (backward delete)', () => {
    const r = new KillRing();
    r.push('foo', { prepend: false });
    r.push('bar', { prepend: true, accumulate: true });
    expect(r.length).toBe(1);
    expect(r.peek()).toBe('barfoo');
  });

  test('accumulate append joins to the most recent entry (forward delete)', () => {
    const r = new KillRing();
    r.push('foo', { prepend: false });
    r.push('bar', { prepend: false, accumulate: true });
    expect(r.length).toBe(1);
    expect(r.peek()).toBe('foobar');
  });

  test('accumulate without an existing entry pushes a fresh one', () => {
    const r = new KillRing();
    r.push('only', { prepend: false, accumulate: true });
    expect(r.length).toBe(1);
    expect(r.peek()).toBe('only');
  });

  test('rotate cycles entries: most-recent moves to oldest', () => {
    const r = new KillRing();
    r.push('a', { prepend: false });
    r.push('b', { prepend: false });
    r.push('c', { prepend: false });
    expect(r.peek()).toBe('c');
    r.rotate();
    expect(r.peek()).toBe('b');
    r.rotate();
    expect(r.peek()).toBe('a');
    r.rotate();
    expect(r.peek()).toBe('c');
  });

  test('empty text is ignored', () => {
    const r = new KillRing();
    r.push('', { prepend: false });
    expect(r.length).toBe(0);
  });
});
