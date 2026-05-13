import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('Write tool diff payload', () => {
  test('existing file: includes hunks against previous contents, no created flag', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-write-diff-existing-'));
    const filePath = join(workspace, 'sample.txt');
    await writeFile(filePath, 'one\ntwo\nthree\n');

    const tool = createBuiltinTools(makeContext()).find(
      (entry) => entry.name === 'Write',
    );
    if (!tool) throw new Error('Write tool missing');

    const result = await tool.execute(
      {
        filePath: 'sample.txt',
        content: 'one\nTWO\nthree\n',
        toolCallId: '1',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as { diff?: DiffPayload; created?: boolean };
    expect(output.created).toBe(false);
    const diff = output.diff;
    if (!diff) throw new Error('diff missing');
    expect(diff.created).toBeUndefined();
    expect(diff.hunks.length).toBeGreaterThan(0);
    const hunk = changeHunk(diff.hunks[0]);
    const addTexts = hunk.lines
      .filter((l) => l.kind === 'add')
      .map((l) => l.text);
    expect(addTexts).toContain('TWO');
  });

  test('new file: marks created=true and emits a single all-added hunk', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-write-diff-new-'));
    const tool = createBuiltinTools(makeContext()).find(
      (entry) => entry.name === 'Write',
    );
    if (!tool) throw new Error('Write tool missing');

    const result = await tool.execute(
      {
        filePath: 'fresh.txt',
        content: 'hello\nworld\n',
        toolCallId: '2',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as { diff?: DiffPayload; created?: boolean };
    expect(output.created).toBe(true);
    const diff = output.diff;
    if (!diff) throw new Error('diff missing');
    expect(diff.created).toBe(true);
    expect(diff.hunks).toHaveLength(1);
    const hunk = changeHunk(diff.hunks[0]);
    expect(hunk.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(hunk.lines.map((l) => l.text)).toEqual(['hello', 'world']);
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
  });

  test('identical write produces identical payload with empty hunks', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-write-diff-identical-'));
    const filePath = join(workspace, 'same.txt');
    await writeFile(filePath, 'noop\n');

    const tool = createBuiltinTools(makeContext()).find(
      (entry) => entry.name === 'Write',
    );
    if (!tool) throw new Error('Write tool missing');

    const result = await tool.execute(
      {
        filePath: 'same.txt',
        content: 'noop\n',
        toolCallId: '3',
      },
      makeContext(),
    );

    const output = result.output as { diff?: DiffPayload };
    const diff = output.diff;
    if (!diff) throw new Error('diff missing');
    expect(diff.identical).toBe(true);
    expect(diff.hunks).toEqual([]);
  });
});
