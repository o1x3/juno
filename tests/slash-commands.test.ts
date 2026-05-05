import { describe, expect, test } from 'bun:test';

import { filterCommands, parseSlashInput, SLASH_COMMANDS } from '@/ui/commands';

describe('parseSlashInput', () => {
  test('non-slash input is not a command', () => {
    const out = parseSlashInput('hello');
    expect(out.isCommand).toBe(false);
  });
  test('parses bare command', () => {
    const out = parseSlashInput('/help');
    expect(out).toEqual({ isCommand: true, name: 'help', args: '' });
  });
  test('parses command with args', () => {
    const out = parseSlashInput('/rename my-session');
    expect(out).toEqual({
      isCommand: true,
      name: 'rename',
      args: 'my-session',
    });
  });
});

describe('filterCommands', () => {
  test('empty query returns all', () => {
    expect(filterCommands('').length).toBe(SLASH_COMMANDS.length);
  });
  test('filters by prefix first', () => {
    const out = filterCommands('/se');
    expect(out.map((c) => c.name)).toContain('settings');
    expect(out.map((c) => c.name)).toContain('sessions');
  });
  test('falls back to substring when no prefix match', () => {
    const out = filterCommands('/rena');
    expect(out.map((c) => c.name)).toContain('rename');
  });
});
