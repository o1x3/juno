import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectInstructions } from '@/core/instructions';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('instruction loading', () => {
  test('loads from git root to cwd with AGENTS winning over CLAUDE in the same directory', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-instructions-'));
    await mkdir(join(workspace, '.git'));
    await mkdir(join(workspace, 'nested', 'child'), { recursive: true });
    await writeFile(join(workspace, 'CLAUDE.md'), 'root claude');
    await writeFile(join(workspace, 'AGENTS.md'), 'root agents');
    await writeFile(join(workspace, 'nested', 'CLAUDE.md'), 'nested claude');
    await writeFile(join(workspace, 'nested', 'AGENTS.md'), 'nested agents');

    const instructions = await loadProjectInstructions(
      join(workspace, 'nested', 'child'),
    );

    expect(instructions.files.map((file) => file.kind)).toEqual([
      'CLAUDE.md',
      'AGENTS.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]);
    expect(instructions.mergedContent.indexOf('nested agents')).toBeGreaterThan(
      instructions.mergedContent.indexOf('nested claude'),
    );
  });
});
