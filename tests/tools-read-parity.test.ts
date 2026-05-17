import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolResult, ToolSpec } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 100_000,
    readLineLimit: 2000,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
    ...over,
  };
}

function read(c: ToolContext): ToolSpec {
  const t = createBuiltinTools(c).find((x) => x.name === 'Read');
  if (!t) throw new Error('Read tool missing');
  return t;
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]);

describe('Read parity (opencode/pi-mono)', () => {
  test('text content is line-numbered', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-num-'));
    await writeFile(join(workspace, 'a.txt'), 'alpha\nbeta\ngamma\n');
    const r = await read(ctx()).execute(
      { filePath: 'a.txt', toolCallId: '1' },
      ctx(),
    );
    const o = r.output as {
      kind: string;
      content: string;
      totalLines: number;
    };
    expect(o.kind).toBe('text');
    expect(o.totalLines).toBe(3);
    expect(o.content).toBe('1: alpha\n2: beta\n3: gamma');
  });

  test('offset/limit windows the file (opencode-style)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-ol-'));
    await writeFile(join(workspace, 'n.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const r = await read(ctx()).execute(
      { filePath: 'n.txt', offset: 2, limit: 2, toolCallId: '1' },
      ctx(),
    );
    const o = r.output as {
      content: string;
      startLine: number;
      endLine: number;
      truncated: boolean;
    };
    expect(o.startLine).toBe(2);
    expect(o.endLine).toBe(3);
    expect(o.content).toBe('2: l2\n3: l3');
    expect(o.truncated).toBe(true);
  });

  test('startLine/endLine still works (back-compat)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-se-'));
    await writeFile(join(workspace, 'n.txt'), 'a\nb\nc\nd\n');
    const r = await read(ctx()).execute(
      { filePath: 'n.txt', startLine: 2, endLine: 3, toolCallId: '1' },
      ctx(),
    );
    expect((r.output as { content: string }).content).toBe('2: b\n3: c');
  });

  test('offset beyond EOF is a clear error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-eof-'));
    await writeFile(join(workspace, 'n.txt'), 'one\ntwo\n');
    const r = await read(ctx()).execute(
      { filePath: 'n.txt', offset: 9, toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('beyond end of file');
  });

  test('directory is read as a sorted listing with trailing slashes', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-dir-'));
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'z.txt'), '');
    await writeFile(join(workspace, 'a.txt'), '');
    const r = await read(ctx()).execute(
      { filePath: '.', toolCallId: '1' },
      ctx(),
    );
    const o = r.output as { kind: string; entries: string[] };
    expect(o.kind).toBe('dir');
    expect(o.entries).toEqual(['a.txt', 'sub/', 'z.txt']);
  });

  test('image file is returned as model-visible media', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-img-'));
    await writeFile(join(workspace, 'p.png'), PNG);
    const r: ToolResult = await read(ctx()).execute(
      { filePath: 'p.png', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect((r.output as { kind: string }).kind).toBe('image');
    expect(r.media?.kind).toBe('image');
    expect(r.media?.mediaType).toBe('image/png');
  });

  test('binary file is refused', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-bin-'));
    await writeFile(
      join(workspace, 'blob.bin'),
      Buffer.from([1, 2, 0, 3, 4, 0, 5]),
    );
    const r = await read(ctx()).execute(
      { filePath: 'blob.bin', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('binary file');
  });

  test('missing file suggests siblings', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-rp-sug-'));
    await writeFile(join(workspace, 'config.json'), '{}');
    const r = await read(ctx()).execute(
      { filePath: 'config.jsonn', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('File not found');
    expect(String(r.output)).toContain('config.json');
  });
});
