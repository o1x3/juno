import { describe, expect, test } from 'bun:test';

import { filterToolsForMode } from '@/core/chat-service';
import { buildSystemPrompt } from '@/core/prompt';
import { createBuiltinTools } from '@/core/tools';
import type { ProjectInstructionSet } from '@/types';

const empty: ProjectInstructionSet = {
  cwd: '/tmp',
  gitRoot: '/tmp',
  files: [],
  mergedContent: '',
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
    expect(out).toContain('Edit, Write, and Bash');
    expect(out).toContain('Switch to exec mode');
  });

  test('default is exec mode', () => {
    const out = buildSystemPrompt(empty);
    expect(out).not.toContain('PLAN MODE');
  });
});

describe('filterToolsForMode', () => {
  const tools = createBuiltinTools({
    cwd: '/tmp',
    outputLimit: 100,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    sessionsDir: '/tmp',
    sessionId: 'x',
  });

  test('plan mode keeps TodoWrite alongside Read and Grep', () => {
    const names = filterToolsForMode(tools, 'plan').map((t) => t.name);
    expect(names).toContain('Read');
    expect(names).toContain('Grep');
    expect(names).toContain('TodoWrite');
    expect(names).not.toContain('Write');
    expect(names).not.toContain('Edit');
    expect(names).not.toContain('Bash');
  });

  test('exec mode keeps every builtin tool', () => {
    const names = filterToolsForMode(tools, 'exec').map((t) => t.name);
    expect(names).toContain('TodoWrite');
    expect(names).toContain('Bash');
    expect(names).toContain('Write');
  });
});
