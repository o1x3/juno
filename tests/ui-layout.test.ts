import { describe, expect, test } from 'bun:test';

import { computeChatHeight } from '@/ui/layout';

describe('computeChatHeight', () => {
  test('subtracts the extra spacer row from available transcript height', () => {
    expect(computeChatHeight(28)).toBe(20);
  });

  test('keeps a minimum transcript height on short terminals', () => {
    expect(computeChatHeight(10)).toBe(8);
    expect(computeChatHeight(8)).toBe(8);
  });
});
