import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DiffPayload } from '@/core/diff';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

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

function getTool(): ToolSpec {
  const tool = createBuiltinTools(makeContext()).find(
    (entry) => entry.name === 'MultiEdit',
  );
  if (!tool) throw new Error('MultiEdit tool missing');
  return tool;
}

type MultiEditOutput = {
  path: string;
  diff: DiffPayload;
  created: boolean;
};

describe('MultiEdit tool', () => {
  test('happy path: three edits all apply, diff populated', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-happy-'));
    const filePath = join(workspace, 'sample.txt');
    await writeFile(filePath, 'alpha\nbeta\ngamma\n');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'sample.txt',
        edits: [
          { old_string: 'alpha', new_string: 'A' },
          { old_string: 'beta', new_string: 'B' },
          { old_string: 'gamma', new_string: 'G' },
        ],
        toolCallId: '1',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as MultiEditOutput;
    expect(output.created).toBe(false);
    expect(output.diff.hunks.length).toBeGreaterThan(0);

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('A\nB\nG\n');
  });

  test('second edit operates on text produced by the first', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-chain-'));
    const filePath = join(workspace, 'chain.txt');
    await writeFile(filePath, 'A\n');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'chain.txt',
        edits: [
          { old_string: 'A', new_string: 'B' },
          { old_string: 'B', new_string: 'C' },
        ],
        toolCallId: '2',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('C\n');
  });

  test('one failed edit aborts the whole operation; file on disk unchanged', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-abort-'));
    const filePath = join(workspace, 'atomic.txt');
    const original = 'hello\nworld\n';
    await writeFile(filePath, original);

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'atomic.txt',
        edits: [
          { old_string: 'hello', new_string: 'HELLO' },
          { old_string: 'NOPE', new_string: 'X' },
          { old_string: 'world', new_string: 'WORLD' },
        ],
        toolCallId: '3',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('edit[1]');

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe(original);
  });

  test('ambiguous match without replace_all rejected with edit index', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-ambig-'));
    const filePath = join(workspace, 'ambig.txt');
    await writeFile(filePath, 'foo foo\n');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'ambig.txt',
        edits: [{ old_string: 'foo', new_string: 'bar' }],
        toolCallId: '4',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    const message = String(result.output);
    expect(message).toContain('edit[0]');
    expect(message).toContain('ambiguous');

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('foo foo\n');
  });

  test('replace_all=true rewrites every occurrence', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-replaceall-'));
    const filePath = join(workspace, 'all.txt');
    await writeFile(filePath, 'foo foo foo\n');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'all.txt',
        edits: [{ old_string: 'foo', new_string: 'bar', replace_all: true }],
        toolCallId: '5',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('bar bar bar\n');
    expect(after.includes('foo')).toBe(false);
  });

  test('create file via empty old_string on first edit', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-create-'));
    const filePath = join(workspace, 'new.txt');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'new.txt',
        edits: [
          { old_string: '', new_string: 'hello\nworld\n' },
          { old_string: 'hello', new_string: 'HELLO' },
        ],
        toolCallId: '6',
      },
      makeContext(),
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as MultiEditOutput;
    expect(output.created).toBe(true);
    expect(output.diff.created).toBe(true);

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('HELLO\nworld\n');
  });

  test('empty edits array rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-empty-'));
    const filePath = join(workspace, 'untouched.txt');
    await writeFile(filePath, 'keep me\n');

    const tool = getTool();
    const result = await tool.execute(
      {
        path: 'untouched.txt',
        edits: [],
        toolCallId: '7',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('empty');

    const after = await readFile(filePath, 'utf8');
    expect(after).toBe('keep me\n');
  });

  test('path outside workspace rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-multiedit-escape-'));

    const tool = getTool();
    const result = await tool.execute(
      {
        path: '../escape.txt',
        edits: [{ old_string: '', new_string: 'oops\n' }],
        toolCallId: '8',
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('escape');

    let escapedFileExists = false;
    try {
      await access(join(workspace, '..', 'escape.txt'));
      escapedFileExists = true;
    } catch {
      // expected
    }
    expect(escapedFileExists).toBe(false);
  });
});
