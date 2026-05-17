import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

// The Grep tool shells out to ripgrep. Behavior tests need `rg`; skip them
// where it is absent (CI installs it so the real behavior is still exercised).
const HAS_RG = Boolean(Bun.which('rg'));
const testRg = test.skipIf(!HAS_RG);

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function ctx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 100_000,
    readLineLimit: 2000,
    bashTimeoutMs: 5000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

function grep(): ToolSpec {
  const t = createBuiltinTools(ctx()).find((x) => x.name === 'Grep');
  if (!t) throw new Error('Grep tool missing');
  return t;
}

type GrepOut = {
  mode: string;
  exitCode: number;
  matchCount: number;
  truncated: boolean;
  stdout: string;
};

async function seed() {
  workspace = await mkdtemp(join(tmpdir(), 'juno-grep-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(
    join(workspace, 'src', 'a.ts'),
    'export const Foo = 1;\nconst foo = 2;\n// TODO: cleanup\n',
  );
  await writeFile(
    join(workspace, 'src', 'b.js'),
    'function Foo() {}\nlet bar = 3;\n',
  );
  await writeFile(join(workspace, 'readme.md'), 'Foo appears here too\n');
}

describe('Grep parity (pi-mono / Claude-rich flags)', () => {
  testRg('content mode returns file:line:text with line numbers', async () => {
    await seed();
    const r = await grep().execute({ pattern: 'Foo', toolCallId: '1' }, ctx());
    const o = r.output as GrepOut;
    expect(o.mode).toBe('content');
    expect(o.stdout).toContain('src/a.ts:1:');
    expect(o.stdout).toContain('export const Foo');
    expect(o.matchCount).toBeGreaterThanOrEqual(3);
  });

  testRg('ignoreCase widens the match', async () => {
    await seed();
    const sensitive = (
      await grep().execute({ pattern: 'foo', toolCallId: '1' }, ctx())
    ).output as GrepOut;
    const insensitive = (
      await grep().execute(
        { pattern: 'foo', ignoreCase: true, toolCallId: '2' },
        ctx(),
      )
    ).output as GrepOut;
    expect(insensitive.matchCount).toBeGreaterThan(sensitive.matchCount);
  });

  testRg('literal treats regex metacharacters as text', async () => {
    await seed();
    await writeFile(join(workspace, 'src', 'c.ts'), 'a.b.c = 1\naxbxc = 2\n');
    const asRegex = (
      await grep().execute(
        { pattern: 'a.b.c', glob: 'c.ts', toolCallId: '1' },
        ctx(),
      )
    ).output as GrepOut;
    const asLiteral = (
      await grep().execute(
        { pattern: 'a.b.c', glob: 'c.ts', literal: true, toolCallId: '2' },
        ctx(),
      )
    ).output as GrepOut;
    expect(asRegex.matchCount).toBe(2); // a.b.c and axbxc
    expect(asLiteral.matchCount).toBe(1); // only a.b.c
  });

  testRg('glob / include filter the file set', async () => {
    await seed();
    const tsOnly = (
      await grep().execute(
        { pattern: 'Foo', include: '*.ts', toolCallId: '1' },
        ctx(),
      )
    ).output as GrepOut;
    expect(tsOnly.stdout).toContain('a.ts');
    expect(tsOnly.stdout).not.toContain('b.js');
    expect(tsOnly.stdout).not.toContain('readme.md');
  });

  testRg('output_mode files_with_matches lists files only', async () => {
    await seed();
    const r = await grep().execute(
      { pattern: 'Foo', output_mode: 'files_with_matches', toolCallId: '1' },
      ctx(),
    );
    const o = r.output as GrepOut;
    expect(o.mode).toBe('files_with_matches');
    expect(o.stdout).toContain('a.ts');
    expect(o.stdout).not.toContain(':1:');
  });

  testRg('output_mode count returns per-file counts', async () => {
    await seed();
    const r = await grep().execute(
      { pattern: 'Foo', output_mode: 'count', toolCallId: '1' },
      ctx(),
    );
    const o = r.output as GrepOut;
    expect(o.mode).toBe('count');
    expect(o.stdout).toMatch(/a\.ts:\d/);
  });

  testRg('context adds surrounding lines', async () => {
    await seed();
    const r = await grep().execute(
      { pattern: 'TODO', context: 1, toolCallId: '1' },
      ctx(),
    );
    const o = r.output as GrepOut;
    expect(o.stdout).toContain('TODO: cleanup');
    expect(o.stdout).toContain('const foo = 2;');
  });

  testRg('limit caps the result set and flags truncation', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-grep-lim-'));
    const lines = Array.from({ length: 20 }, (_, i) => `match ${i}`).join('\n');
    await writeFile(join(workspace, 'big.txt'), lines);
    const r = await grep().execute(
      { pattern: 'match', limit: 5, toolCallId: '1' },
      ctx(),
    );
    const o = r.output as GrepOut;
    expect(o.truncated).toBe(true);
    expect(o.stdout.split('\n').length).toBe(5);
  });

  testRg('no matches → exitCode 1, not an error', async () => {
    await seed();
    const r = await grep().execute(
      { pattern: 'zzz-not-here', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect((r.output as GrepOut).exitCode).toBe(1);
    expect((r.output as GrepOut).matchCount).toBe(0);
  });
});

describe('Grep without ripgrep', () => {
  test('returns a clear, actionable error when rg is not on PATH', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-grep-norg-'));
    const tool = createBuiltinTools(ctx(), {
      which: () => false,
    }).find((x) => x.name === 'Grep') as ToolSpec;
    const r = await tool.execute(
      { pattern: 'anything', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('ripgrep');
    expect(String(r.output)).toContain('not on PATH');
  });
});
