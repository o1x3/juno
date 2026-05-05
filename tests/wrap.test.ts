import { describe, expect, test } from 'bun:test';

import { visibleWidth, wrapLine } from '@/ui/format';

describe('visibleWidth', () => {
  test('ASCII length', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('')).toBe(0);
  });

  test('CJK characters are width 2', () => {
    // Greeting in Japanese; each kana is double-width in terminals.
    expect(visibleWidth('こんにちは')).toBe(10);
  });

  test('emoji is width 2', () => {
    expect(visibleWidth('a😀b')).toBe(4);
  });

  test('combining marks contribute zero width', () => {
    // 'é' as e + combining acute (U+0301) — base + combining → width 1.
    expect(visibleWidth('é')).toBe(1);
  });
});

describe('wrapLine', () => {
  test('short string returns one chunk spanning the whole line', () => {
    const chunks = wrapLine('hello', 80);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe('hello');
    expect(chunks[0]?.startIndex).toBe(0);
    expect(chunks[0]?.endIndex).toBe(5);
  });

  test('empty input returns a single empty chunk', () => {
    const chunks = wrapLine('', 80);
    expect(chunks).toEqual([{ text: '', startIndex: 0, endIndex: 0 }]);
  });

  test('wraps at the last whitespace boundary before overflow', () => {
    const chunks = wrapLine('one two three four', 8);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk ends at a space boundary.
    const first = chunks[0]?.text ?? '';
    expect(first.endsWith(' ') || first === 'one two').toBe(true);
  });

  test('chunk indices reconstruct the original string', () => {
    const line = 'alpha bravo charlie delta echo foxtrot';
    const chunks = wrapLine(line, 12);
    // Walk indices: every chunk's text equals the slice from start..end.
    for (const c of chunks) {
      expect(line.slice(c.startIndex, c.endIndex)).toBe(c.text);
    }
    // The combined chunks (with the gap whitespace stripped from the slice)
    // re-cover the input start to end.
    expect(chunks[0]?.startIndex).toBe(0);
    expect(chunks[chunks.length - 1]?.endIndex).toBe(line.length);
  });

  test('long token without spaces force-wraps at width boundary', () => {
    const chunks = wrapLine('abcdefghijklmnop', 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Each chunk fits within the width budget.
      expect(visibleWidth(c.text)).toBeLessThanOrEqual(5);
    }
  });

  test('zero or negative width falls back to a single empty chunk', () => {
    expect(wrapLine('hello', 0)).toEqual([
      { text: '', startIndex: 0, endIndex: 0 },
    ]);
  });
});
