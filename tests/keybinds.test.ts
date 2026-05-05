import { describe, expect, test } from 'bun:test';

import { describeBinding, matchKeybind, matchSpec } from '@/ui/keybinds';

describe('matchSpec', () => {
  test('shift+tab matches', () => {
    expect(
      matchSpec({ shift: true, key: 'tab' }, '', { tab: true, shift: true }),
    ).toBe(true);
  });
  test('shift+tab does not match plain tab', () => {
    expect(
      matchSpec({ shift: true, key: 'tab' }, '', { tab: true, shift: false }),
    ).toBe(false);
  });
  test('ctrl+input matches when ctrl set', () => {
    expect(matchSpec({ ctrl: true, input: 'g' }, 'g', { ctrl: true })).toBe(
      true,
    );
  });
  test('ctrl+input does not match when ctrl absent', () => {
    expect(matchSpec({ ctrl: true, input: 'g' }, 'g', {})).toBe(false);
  });
});

describe('matchKeybind', () => {
  test('mode-toggle id matches shift+tab', () => {
    expect(matchKeybind('mode-toggle', '', { tab: true, shift: true })).toBe(
      true,
    );
  });
  test('pane-toggle matches ctrl+g', () => {
    expect(matchKeybind('pane-toggle', 'g', { ctrl: true })).toBe(true);
  });
  test('newline matches ctrl+j', () => {
    expect(matchKeybind('newline', 'j', { ctrl: true })).toBe(true);
  });
});

describe('describeBinding', () => {
  test('renders modifiers and key', () => {
    expect(describeBinding({ ctrl: true, input: 'g' })).toBe('⌃G');
    expect(describeBinding({ shift: true, key: 'tab' })).toBe('⇧⇥');
    expect(describeBinding({ key: 'enter' })).toBe('⏎');
  });
});
