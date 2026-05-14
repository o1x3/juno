import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DiffHunk, DiffPayload } from '@/core/diff';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function makeContext(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 2000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

function changeHunk(h: DiffHunk | undefined) {
  if (!h || h.kind !== 'change') throw new Error('expected change hunk');
  return h;
}

describe('Edit tool diff payload', () => {
  test('attaches a non-empty diff with add+del lines after a successful edit', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-edit-diff-'));
    const filePath = join(workspace, 'sample.txt');
    await writeFile(filePath, 'alpha\nbeta\ngamma\n');

    const tool = createBuiltinTools(makeContext()).find(
      (entry) => entry.name === 'Edit',
    );
    if (!tool) throw new Error('Edit tool missing');

    const result = await tool.execute(
      {
        filePath: 'sample.txt',
        oldString: 'beta',
        newString: 'BETA',
        toolCallId: '1',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as { diff?: DiffPayload };
    expect(output.diff).toBeTruthy();
    const diff = output.diff;
    if (!diff) throw new Error('diff missing');
    expect(diff.hunks.length).toBeGreaterThan(0);
    const hunk = changeHunk(diff.hunks[0]);
    const addTexts = hunk.lines
      .filter((l) => l.kind === 'add')
      .map((l) => l.text);
    const delTexts = hunk.lines
      .filter((l) => l.kind === 'del')
      .map((l) => l.text);
    expect(delTexts).toContain('beta');
    expect(addTexts).toContain('BETA');

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('alpha\nBETA\ngamma\n');
  });

  test('Edit rejects paths escaping the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-edit-escape-'));
    const tool = createBuiltinTools(makeContext()).find(
      (entry) => entry.name === 'Edit',
    );
    if (!tool) throw new Error('Edit tool missing');

    const result = await tool.execute(
      {
        filePath: '../outside.txt',
        oldString: 'a',
        newString: 'b',
        toolCallId: '1',
      },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/resolves outside workspace root/);
  });
});
