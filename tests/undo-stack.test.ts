import { describe, expect, test } from 'bun:test';

import { UndoStack } from '@/ui/undo-stack';

describe('UndoStack', () => {
  test('empty stack pop returns undefined', () => {
    const s = new UndoStack<{ value: string }>();
    expect(s.pop()).toBeUndefined();
    expect(s.length).toBe(0);
  });

  test('push / pop returns most-recent state', () => {
    const s = new UndoStack<{ value: string }>();
    s.push({ value: 'a' });
    s.push({ value: 'b' });
    expect(s.length).toBe(2);
    expect(s.pop()).toEqual({ value: 'b' });
    expect(s.pop()).toEqual({ value: 'a' });
    expect(s.pop()).toBeUndefined();
  });

  test('snapshots are deep-cloned (mutations to source do not affect stack)', () => {
    const s = new UndoStack<{ items: string[] }>();
    const state = { items: ['x'] };
    s.push(state);
    state.items.push('y');
    const popped = s.pop();
    expect(popped).toEqual({ items: ['x'] });
  });

  test('clear empties the stack', () => {
    const s = new UndoStack<{ n: number }>();
    s.push({ n: 1 });
    s.push({ n: 2 });
    s.clear();
    expect(s.length).toBe(0);
    expect(s.pop()).toBeUndefined();
  });
});
