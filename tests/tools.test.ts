import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('builtin tools', () => {
  test('edit fails on ambiguous match', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-tools-'));
    const filePath = join(workspace, 'file.txt');
    await writeFile(filePath, 'a\na\n');
    const tool = createBuiltinTools({
      cwd: workspace,
      outputLimit: 200,
      readLineLimit: 50,
      bashTimeoutMs: 1000,
      sessionsDir: workspace,
      sessionId: 'test',
    }).find((entry) => entry.name === 'Edit');
    if (!tool) {
      throw new Error('Edit tool missing');
    }

    const result = await tool.execute(
      {
        filePath: 'file.txt',
        oldString: 'a',
        newString: 'b',
        toolCallId: '1',
      },
      {
        cwd: workspace,
        outputLimit: 200,
        readLineLimit: 50,
        bashTimeoutMs: 1000,
        sessionsDir: workspace,
        sessionId: 'test',
      },
    );

    expect(result.isError).toBe(true);
  });

  test('read returns bounded content', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-read-'));
    const filePath = join(workspace, 'file.txt');
    await writeFile(filePath, '1\n2\n3\n4\n5\n');
    const tool = createBuiltinTools({
      cwd: workspace,
      outputLimit: 2,
      readLineLimit: 2,
      bashTimeoutMs: 1000,
      sessionsDir: workspace,
      sessionId: 'test',
    }).find((entry) => entry.name === 'Read');
    if (!tool) {
      throw new Error('Read tool missing');
    }

    const result = await tool.execute(
      {
        filePath: 'file.txt',
        toolCallId: '1',
      },
      {
        cwd: workspace,
        outputLimit: 2,
        readLineLimit: 2,
        bashTimeoutMs: 1000,
        sessionsDir: workspace,
        sessionId: 'test',
      },
    );

    expect(String((result.output as { content: string }).content)).toContain(
      '[truncated',
    );
  });

  test('read rejects paths escaping the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-read-escape-'));
    const ctx = {
      cwd: workspace,
      outputLimit: 200,
      readLineLimit: 50,
      bashTimeoutMs: 1000,
      sessionsDir: workspace,
      sessionId: 'test',
    };
    const tool = createBuiltinTools(ctx).find((entry) => entry.name === 'Read');
    if (!tool) throw new Error('Read tool missing');

    const result = await tool.execute(
      { filePath: '../outside.txt', toolCallId: '1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/resolves outside workspace root/);
  });

  test('write rejects absolute paths outside the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-write-escape-'));
    const ctx = {
      cwd: workspace,
      outputLimit: 200,
      readLineLimit: 50,
      bashTimeoutMs: 1000,
      sessionsDir: workspace,
      sessionId: 'test',
    };
    const tool = createBuiltinTools(ctx).find(
      (entry) => entry.name === 'Write',
    );
    if (!tool) throw new Error('Write tool missing');

    const result = await tool.execute(
      {
        filePath: '/etc/juno-test-escape',
        content: 'pwned',
        toolCallId: '1',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toMatch(/resolves outside workspace root/);
  });
});
