import { describe, expect, test } from 'bun:test';

import { computeLineDiff, DIFF_MAX_BYTES, type DiffHunk } from '@/core/diff';

function changeHunk(h: DiffHunk | undefined) {
  if (!h || h.kind !== 'change') throw new Error('expected change hunk');
  return h;
}

function truncatedHunk(h: DiffHunk | undefined) {
  if (!h || h.kind !== 'truncated') throw new Error('expected truncated hunk');
  return h;
}

describe('computeLineDiff', () => {
  test('identical inputs return identical: true with no hunks', () => {
    const result = computeLineDiff('a\nb\nc\n', 'a\nb\nc\n');
    expect(result.identical).toBe(true);
    expect(result.hunks).toEqual([]);
  });

  test('single-line change produces one change hunk with surrounding context', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const newText = ['a', 'b', 'X', 'd', 'e'].join('\n');
    const result = computeLineDiff(oldText, newText);
    expect(result.hunks).toHaveLength(1);
    const hunk = changeHunk(result.hunks[0]);
    const dels = hunk.lines.filter((l) => l.kind === 'del');
    const adds = hunk.lines.filter((l) => l.kind === 'add');
    expect(dels.map((d) => d.text)).toEqual(['c']);
    expect(adds.map((a) => a.text)).toEqual(['X']);
    const ctxTexts = hunk.lines
      .filter((l) => l.kind === 'ctx')
      .map((l) => l.text);
    expect(ctxTexts).toContain('b');
    expect(ctxTexts).toContain('d');
  });

  test('two changes separated by enough unchanged lines split into two hunks', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const next = [...old];
    next[1] = 'CHANGE_A';
    next[15] = 'CHANGE_B';
    const result = computeLineDiff(old.join('\n'), next.join('\n'));
    expect(result.hunks).toHaveLength(2);
  });

  test('oversize side returns a truncated hunk', () => {
    const big = 'x\n'.repeat(DIFF_MAX_BYTES);
    const result = computeLineDiff(big, 'short\n');
    expect(result.hunks).toHaveLength(1);
    const hunk = truncatedHunk(result.hunks[0]);
    expect(hunk.reason).toBe('oversize');
    expect(hunk.oldBytes).toBeGreaterThan(DIFF_MAX_BYTES);
  });

  test('all-added (empty old) produces one add-only hunk with oldStart=0', () => {
    const result = computeLineDiff('', 'a\nb\nc\n');
    expect(result.hunks).toHaveLength(1);
    const hunk = changeHunk(result.hunks[0]);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.oldStart).toBe(0);
    expect(hunk.newLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(hunk.lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  test('all-deleted (empty new) produces one del-only hunk with newStart=0', () => {
    const result = computeLineDiff('a\nb\nc\n', '');
    expect(result.hunks).toHaveLength(1);
    const hunk = changeHunk(result.hunks[0]);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newLines).toBe(0);
    expect(hunk.newStart).toBe(0);
    expect(hunk.lines.every((l) => l.kind === 'del')).toBe(true);
  });
});
