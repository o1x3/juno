import { describe, expect, test } from 'bun:test';

import type { DiffLine } from '@/core/diff';
import {
  collapseHunkLines,
  HUNK_COLLAPSE_THRESHOLD,
  HUNK_HEAD_LINES,
  HUNK_TAIL_LINES,
} from '@/ui/diff-render';

function makeLines(count: number): DiffLine[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'ctx' as const,
    oldLine: i + 1,
    newLine: i + 1,
    text: `line${i + 1}`,
  }));
}

describe('collapseHunkLines', () => {
  test('hunks at or under the threshold are not collapsed', () => {
    const result = collapseHunkLines(makeLines(10));
    expect(result.collapsed).toBe(false);
    if (result.collapsed) throw new Error('unreachable');
    expect(result.lines).toHaveLength(10);
  });

  test('exactly threshold lines is not collapsed', () => {
    const result = collapseHunkLines(makeLines(HUNK_COLLAPSE_THRESHOLD));
    expect(result.collapsed).toBe(false);
  });

  test('one over threshold collapses with head + tail and hidden count', () => {
    const total = HUNK_COLLAPSE_THRESHOLD + 1;
    const result = collapseHunkLines(makeLines(total));
    expect(result.collapsed).toBe(true);
    if (!result.collapsed) throw new Error('unreachable');
    expect(result.head).toHaveLength(HUNK_HEAD_LINES);
    expect(result.tail).toHaveLength(HUNK_TAIL_LINES);
    expect(result.hiddenCount).toBe(total - HUNK_HEAD_LINES - HUNK_TAIL_LINES);
  });

  test('large hunk collapses; head+tail count is bounded', () => {
    const result = collapseHunkLines(makeLines(100));
    expect(result.collapsed).toBe(true);
    if (!result.collapsed) throw new Error('unreachable');
    expect(result.head.length + result.tail.length).toBeLessThanOrEqual(
      HUNK_HEAD_LINES + HUNK_TAIL_LINES,
    );
    expect(result.hiddenCount).toBe(100 - HUNK_HEAD_LINES - HUNK_TAIL_LINES);
    expect(result.head[0]?.text).toBe('line1');
    expect(result.tail[result.tail.length - 1]?.text).toBe('line100');
  });
});
