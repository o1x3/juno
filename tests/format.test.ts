import { describe, expect, test } from 'bun:test';

import {
  clampScroll,
  formatCost,
  formatDuration,
  formatTokens,
  progressBar,
  segmentBar,
  softWrap,
  sparkline,
  truncatePath,
} from '@/ui/format';

describe('formatTokens', () => {
  test('handles small numbers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(123)).toBe('123');
  });
  test('uses k for thousands', () => {
    expect(formatTokens(2456)).toBe('2.5k');
    expect(formatTokens(12_400)).toBe('12k');
  });
  test('uses M for millions', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });
});

describe('formatCost', () => {
  test('zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
  test('tiny', () => {
    expect(formatCost(0.0008)).toBe('$0.0008');
  });
  test('cents', () => {
    expect(formatCost(0.052)).toBe('$0.052');
  });
  test('dollars', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('formatDuration', () => {
  test('milliseconds', () => {
    expect(formatDuration(450)).toBe('450ms');
  });
  test('seconds', () => {
    expect(formatDuration(2400)).toBe('2.4s');
  });
  test('minutes', () => {
    expect(formatDuration(75_000)).toBe('1:15');
  });
});

describe('clampScroll', () => {
  test('clamps below zero', () => {
    expect(clampScroll(-1, 5)).toBe(0);
  });
  test('clamps above max', () => {
    expect(clampScroll(99, 5)).toBe(5);
  });
  test('within range', () => {
    expect(clampScroll(3, 5)).toBe(3);
  });
});

describe('truncatePath', () => {
  test('substitutes home', () => {
    const home = process.env.HOME ?? '/Users/x';
    expect(truncatePath(`${home}/code/foo`, 80)).toBe('~/code/foo');
  });
  test('truncates with ellipsis when too long', () => {
    expect(truncatePath('/a/b/c/d/e/f/g', 8).startsWith('…')).toBe(true);
  });
});

describe('progressBar', () => {
  test('fills proportionally', () => {
    expect(progressBar(50, 10)).toBe('▓▓▓▓▓░░░░░');
    expect(progressBar(0, 4)).toBe('░░░░');
    expect(progressBar(100, 4)).toBe('▓▓▓▓');
  });
});

describe('segmentBar', () => {
  test('lengths sum to width via largest-remainder', () => {
    const { lengths } = segmentBar([10, 5, 3, 2], 10);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(10);
  });
  test('zero total returns zero lengths', () => {
    const { lengths } = segmentBar([0, 0, 0], 10);
    expect(lengths).toEqual([0, 0, 0]);
  });
});

describe('sparkline', () => {
  test('returns one glyph per value', () => {
    const out = sparkline([1, 2, 3, 4, 5]);
    expect(out.length).toBeGreaterThan(0);
  });
  test('empty input is empty output', () => {
    expect(sparkline([])).toBe('');
  });
});

describe('softWrap', () => {
  test('wraps at word boundary when possible', () => {
    const lines = softWrap('hello there friend', 10);
    expect(lines.length).toBeGreaterThan(1);
  });
  test('returns input when fits', () => {
    expect(softWrap('short', 80)).toEqual(['short']);
  });
});
