import { describe, expect, test } from 'bun:test';

import { buildSystemPrompt } from '@/core/prompt';
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
