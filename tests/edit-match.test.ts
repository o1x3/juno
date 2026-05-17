import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EditMatchError, replace } from '@/core/edit-match';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

describe('replace() cascade (opencode parity)', () => {
  test('exact match (SimpleReplacer)', () => {
    expect(replace('const a = 1;', 'a = 1', 'a = 2')).toBe('const a = 2;');
  });

  test('identical strings throw', () => {
    let err: unknown;
    try {
      replace('x', 'x', 'x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EditMatchError);
    expect((err as EditMatchError).reason).toBe('identical');
  });

  test('not found throws not-found', () => {
    let err: unknown;
    try {
      replace('abc', 'zzz', 'q');
    } catch (e) {
      err = e;
    }
    expect((err as EditMatchError).reason).toBe('not-found');
  });

  test('ambiguous exact match throws multiple', () => {
    let err: unknown;
    try {
      replace('a\na\n', 'a', 'b');
    } catch (e) {
      err = e;
    }
    expect((err as EditMatchError).reason).toBe('multiple');
  });

  test('replaceAll rewrites every occurrence', () => {
    expect(replace('a\na\n', 'a', 'b', true)).toBe('b\nb\n');
  });

  test('LineTrimmedReplacer: indentation mismatch still matches', () => {
    const content = 'function f() {\n    return 1;\n}\n';
    // old_string has no leading indentation.
    const out = replace(content, 'return 1;', 'return 2;');
    expect(out).toBe('function f() {\n    return 2;\n}\n');
  });

  test('IndentationFlexibleReplacer: whole block re-indented', () => {
    const content = '    if (x) {\n        go();\n    }\n';
    const find = 'if (x) {\n    go();\n}';
    const out = replace(content, find, 'if (y) { stop(); }');
    expect(out).toContain('if (y) { stop(); }');
    expect(out).not.toContain('go();');
  });

  test('EscapeNormalizedReplacer: escaped newline in old_string', () => {
    const content = 'line1\nline2\n';
    const out = replace(content, 'line1\\nline2', 'X');
    expect(out).toBe('X\n');
  });

  test('WhitespaceNormalizedReplacer: collapsed whitespace', () => {
    const content = 'const   a    =     1;';
    const out = replace(content, 'const a = 1;', 'const a = 2;');
    expect(out).toBe('const a = 2;');
  });
});

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
    outputLimit: 10_000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}
function editTool(): ToolSpec {
  const t = createBuiltinTools(ctx()).find((x) => x.name === 'Edit');
  if (!t) throw new Error('Edit tool missing');
  return t;
}

describe('Edit tool with fuzzy fallback', () => {
  test('applies an edit whose old_string has the wrong indentation', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ef-'));
    await writeFile(
      join(workspace, 's.ts'),
      'class C {\n  method() {\n    doThing();\n  }\n}\n',
    );
    const r = await editTool().execute(
      {
        filePath: 's.ts',
        oldString: 'doThing();',
        newString: 'doOtherThing();',
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(workspace, 's.ts'), 'utf8')).toBe(
      'class C {\n  method() {\n    doOtherThing();\n  }\n}\n',
    );
  });

  test('replaceAll edits every occurrence', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ef-all-'));
    await writeFile(join(workspace, 'm.txt'), 'x\nx\nx\n');
    const r = await editTool().execute(
      {
        filePath: 'm.txt',
        oldString: 'x',
        newString: 'y',
        replaceAll: true,
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(workspace, 'm.txt'), 'utf8')).toBe('y\ny\ny\n');
  });

  test('ambiguous match without replaceAll is rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ef-amb-'));
    await writeFile(join(workspace, 'm.txt'), 'x\nx\n');
    const r = await editTool().execute(
      {
        filePath: 'm.txt',
        oldString: 'x',
        newString: 'y',
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('multiple matches');
  });
});
