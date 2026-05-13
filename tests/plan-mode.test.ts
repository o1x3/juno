import { describe, expect, test } from 'bun:test';

import { filterToolsForMode, PLAN_MODE_TOOLS } from '@/core/chat-service';
import { buildSystemPrompt } from '@/core/prompt';
import { createBuiltinTools } from '@/core/tools';
import type { ProjectInstructionSet, ToolContext } from '@/types';

const empty: ProjectInstructionSet = {
  cwd: '/tmp',
  gitRoot: '/tmp',
  files: [],
  mergedContent: '',
};

const ctx: ToolContext = {
  cwd: '/tmp',
  outputLimit: 1000,
  readLineLimit: 50,
  bashTimeoutMs: 1000,
  sessionsDir: '/tmp',
  sessionId: 'x',
};

describe('buildSystemPrompt', () => {
  test('exec mode does not include plan preamble', () => {
    const out = buildSystemPrompt(empty, 'exec');
    expect(out).not.toContain('PLAN MODE');
  });

  test('plan mode includes plan preamble and forbids write tools', () => {
    const out = buildSystemPrompt(empty, 'plan');
    expect(out).toContain('PLAN MODE');
    expect(out).toContain('Read');
    expect(out).toContain('Grep');
    expect(out).toContain('Glob');
    expect(out).toContain('LS');
    expect(out).toContain('Edit, Write, and Bash');
    expect(out).toContain('Switch to exec mode');
  });

  test('default is exec mode', () => {
    const out = buildSystemPrompt(empty);
    expect(out).not.toContain('PLAN MODE');
  });
});

describe('plan-mode tool allowlist', () => {
  test('allowlist contains Read, Grep, Glob, LS, TodoWrite', () => {
    expect(PLAN_MODE_TOOLS.has('Read')).toBe(true);
    expect(PLAN_MODE_TOOLS.has('Grep')).toBe(true);
    expect(PLAN_MODE_TOOLS.has('Glob')).toBe(true);
    expect(PLAN_MODE_TOOLS.has('LS')).toBe(true);
    expect(PLAN_MODE_TOOLS.has('TodoWrite')).toBe(true);
  });

  test('filterToolsForMode("plan") exposes read-only tools and TodoWrite, drops mutating tools', () => {
    const filtered = filterToolsForMode(createBuiltinTools(ctx), 'plan').map(
      (t) => t.name,
    );
    expect(filtered).toContain('Read');
    expect(filtered).toContain('Grep');
    expect(filtered).toContain('Glob');
    expect(filtered).toContain('LS');
    expect(filtered).toContain('TodoWrite');
    expect(filtered).not.toContain('Bash');
    expect(filtered).not.toContain('Write');
    expect(filtered).not.toContain('Edit');
  });

  test('filterToolsForMode("exec") returns the full set', () => {
    const filtered = filterToolsForMode(createBuiltinTools(ctx), 'exec').map(
      (t) => t.name,
    );
    for (const name of [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Grep',
      'Glob',
      'LS',
      'TodoWrite',
    ] as const) {
      expect(filtered).toContain(name);
    }
  });
});
