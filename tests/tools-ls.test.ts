import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

let workspace = '';

function makeContext(cwd: string): ToolContext {
  return {
    cwd,
    outputLimit: 4000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    sessionsDir: cwd,
    sessionId: 'test-session',
  };
}

function getLs(cwd: string): ToolSpec {
  const tool = createBuiltinTools(makeContext(cwd)).find(
    (entry) => entry.name === 'LS',
  );
  if (!tool) throw new Error('LS tool missing');
  return tool;
}

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

type LsEntry = {
  name: string;
  type: 'dir' | 'file' | 'symlink';
  size?: number;
};

describe('LS tool', () => {
  test('lists dirs first then files, alpha within group, with sizes on files', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    await mkdir(join(workspace, 'zeta'), { recursive: true });
    await mkdir(join(workspace, 'alpha'), { recursive: true });
    await writeFile(join(workspace, 'beta.txt'), 'hello');
    await writeFile(join(workspace, 'gamma.txt'), 'hi');

    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: '.', toolCallId: '1' },
      makeContext(workspace),
    );
    expect(result.isError).toBeUndefined();
    const output = result.output as { entries: LsEntry[]; truncated: boolean };
    expect(output.entries.map((e) => e.name)).toEqual([
      'alpha',
      'zeta',
      'beta.txt',
      'gamma.txt',
    ]);
    const beta = output.entries.find((e) => e.name === 'beta.txt');
    expect(beta?.type).toBe('file');
    expect(beta?.size).toBe(5);
    const alpha = output.entries.find((e) => e.name === 'alpha');
    expect(alpha?.type).toBe('dir');
    expect(alpha?.size).toBeUndefined();
  });

  test('hides dotfiles by default', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    await writeFile(join(workspace, 'visible.txt'), 'v');
    await writeFile(join(workspace, '.hidden'), 'h');

    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: '.', toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as { entries: LsEntry[] };
    expect(output.entries.map((e) => e.name)).toEqual(['visible.txt']);
  });

  test('reveals dotfiles when hidden=true', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    await writeFile(join(workspace, 'visible.txt'), 'v');
    await writeFile(join(workspace, '.hidden'), 'h');

    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: '.', hidden: true, toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as { entries: LsEntry[] };
    const names = output.entries.map((e) => e.name).sort();
    expect(names).toEqual(['.hidden', 'visible.txt']);
  });

  test('rejects paths escaping the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: '..', toolCallId: '1' },
      makeContext(workspace),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/escapes workspace/);
  });

  test('rejects absolute paths outside the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: '/tmp', toolCallId: '1' },
      makeContext(workspace),
    );
    expect(result.isError).toBe(true);
  });

  test('caps at 500 entries and reports truncation', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ls-'));
    const dir = join(workspace, 'many');
    await mkdir(dir, { recursive: true });
    const total = 510;
    for (let i = 0; i < total; i++) {
      await writeFile(join(dir, `f${String(i).padStart(4, '0')}.txt`), '');
    }
    const tool = getLs(workspace);
    const result = await tool.execute(
      { path: 'many', toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as {
      entries: LsEntry[];
      truncated: boolean;
      truncationMarker?: string;
    };
    expect(output.truncated).toBe(true);
    expect(output.entries.length).toBe(500);
    expect(output.truncationMarker).toBeDefined();
  });
});
