import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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

function getGlob(cwd: string): ToolSpec {
  const tool = createBuiltinTools(makeContext(cwd)).find(
    (entry) => entry.name === 'Glob',
  );
  if (!tool) throw new Error('Glob tool missing');
  return tool;
}

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('Glob tool', () => {
  test('returns workspace-relative matches', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'a.ts'), 'a');
    await writeFile(join(workspace, 'src', 'b.ts'), 'b');
    await writeFile(join(workspace, 'README.md'), 'readme');

    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: '**/*.ts', toolCallId: '1' },
      makeContext(workspace),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as { matches: string[]; truncated: boolean };
    expect(output.matches.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(output.truncated).toBe(false);
  });

  test('skips node_modules, .git, dist, .claude', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    for (const dir of ['node_modules', '.git', 'dist', '.claude', 'src']) {
      await mkdir(join(workspace, dir), { recursive: true });
      await writeFile(join(workspace, dir, 'x.ts'), 'x');
    }

    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: '**/*.ts', toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as { matches: string[] };
    expect(output.matches).toEqual(['src/x.ts']);
  });

  test('rejects cwd that escapes the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: '*', cwd: '..', toolCallId: '1' },
      makeContext(workspace),
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/resolves outside workspace root/);
  });

  test('rejects absolute cwd outside the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: '*', cwd: '/tmp', toolCallId: '1' },
      makeContext(workspace),
    );
    expect(result.isError).toBe(true);
  });

  test('sorts matches by mtime descending', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    const older = join(workspace, 'older.ts');
    const newer = join(workspace, 'newer.ts');
    await writeFile(older, 'older');
    await writeFile(newer, 'newer');
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    await utimes(older, past, past);
    await utimes(newer, now, now);

    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: '*.ts', toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as { matches: string[] };
    expect(output.matches).toEqual(['newer.ts', 'older.ts']);
  });

  test('caps results at 1000 and reports truncation', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-glob-'));
    const dir = join(workspace, 'many');
    await mkdir(dir, { recursive: true });
    const total = 1005;
    for (let i = 0; i < total; i++) {
      await writeFile(join(dir, `f${i}.txt`), '');
    }
    const tool = getGlob(workspace);
    const result = await tool.execute(
      { pattern: 'many/*.txt', toolCallId: '1' },
      makeContext(workspace),
    );
    const output = result.output as {
      matches: string[];
      truncated: boolean;
      truncationMarker?: string;
    };
    expect(output.truncated).toBe(true);
    expect(output.matches.length).toBe(1000);
    expect(output.truncationMarker).toBeDefined();
  });
});
