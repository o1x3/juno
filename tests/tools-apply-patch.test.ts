import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ToolContext,
  ToolSpec,
} from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function makeContext(
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>,
): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 4000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
    requestApproval,
  };
}

function getTool(ctx: ToolContext): ToolSpec {
  const tool = createBuiltinTools(ctx).find((t) => t.name === 'apply_patch');
  if (!tool) throw new Error('apply_patch tool missing');
  return tool;
}

const wrap = (...lines: string[]) =>
  ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('apply_patch tool', () => {
  test('add + update + delete + move in one atomic call', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-all-'));
    await writeFile(join(workspace, 'update.py'), 'def f():\n    pass\n');
    await writeFile(join(workspace, 'gone.txt'), 'bye\n');
    await writeFile(join(workspace, 'old.txt'), 'keep\nmove me\n');

    const ctx = makeContext();
    const tool = getTool(ctx);
    const result = await tool.execute(
      {
        input: wrap(
          '*** Add File: new.txt',
          '+hello',
          '+world',
          '*** Update File: update.py',
          '@@ def f():',
          '-    pass',
          '+    return 123',
          '*** Delete File: gone.txt',
          '*** Update File: old.txt',
          '*** Move to: renamed.txt',
          '@@',
          ' keep',
          '-move me',
          '+moved',
        ),
        toolCallId: '1',
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const out = result.output as {
      added: string[];
      modified: string[];
      deleted: string[];
      files: { op: string }[];
    };
    expect(out.added).toEqual(['new.txt']);
    expect(out.deleted).toEqual(['gone.txt']);
    expect(out.modified).toContain('update.py');
    expect(out.modified.some((m) => m.includes('renamed.txt'))).toBe(true);
    expect(out.files.map((f) => f.op).sort()).toEqual([
      'add',
      'delete',
      'move',
      'update',
    ]);

    expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe(
      'hello\nworld\n',
    );
    expect(await readFile(join(workspace, 'update.py'), 'utf8')).toBe(
      'def f():\n    return 123\n',
    );
    await expect(access(join(workspace, 'gone.txt'))).rejects.toThrow();
    await expect(access(join(workspace, 'old.txt'))).rejects.toThrow();
    expect(await readFile(join(workspace, 'renamed.txt'), 'utf8')).toBe(
      'keep\nmoved\n',
    );
  });

  test('rejection blocks every file write', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-reject-'));
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    const ctx = makeContext(async () => 'reject');
    const tool = getTool(ctx);
    const result = await tool.execute(
      {
        input: wrap(
          '*** Add File: b.txt',
          '+new',
          '*** Update File: a.txt',
          '@@',
          '-one',
          '+ONE',
        ),
        toolCallId: '1',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected apply_patch');
    await expect(access(join(workspace, 'b.txt'))).rejects.toThrow();
    expect(await readFile(join(workspace, 'a.txt'), 'utf8')).toBe('one\n');
  });

  test('reject-with-reason surfaces the reason to the model', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-reason-'));
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    const ctx = makeContext(async () => ({
      decision: 'reject',
      reason: 'not now',
    }));
    const tool = getTool(ctx);
    const result = await tool.execute(
      {
        input: wrap('*** Update File: a.txt', '@@', '-one', '+ONE'),
        toolCallId: '1',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('not now');
  });

  test('approval preview carries per-file diffs', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-preview-'));
    await writeFile(join(workspace, 'a.txt'), 'one\n');
    let captured: ApprovalRequest | undefined;
    const ctx = makeContext(async (req) => {
      captured = req;
      return 'approve';
    });
    const tool = getTool(ctx);
    await tool.execute(
      {
        input: wrap(
          '*** Add File: b.txt',
          '+x',
          '*** Update File: a.txt',
          '@@',
          '-one',
          '+ONE',
        ),
        toolCallId: '1',
      },
      ctx,
    );
    expect(captured?.toolName).toBe('apply_patch');
    expect(captured?.preview.kind).toBe('apply-patch');
    if (captured?.preview.kind === 'apply-patch') {
      expect(captured.preview.files).toHaveLength(2);
      expect(captured.preview.files[0]?.op).toBe('add');
      expect(captured.preview.files[0]?.diff?.created).toBe(true);
      expect(captured.preview.files[1]?.op).toBe('update');
      expect(captured.preview.files[1]?.diff?.hunks.length).toBeGreaterThan(0);
    }
  });

  test('missing patch text is a friendly error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-empty-'));
    const ctx = makeContext();
    const tool = getTool(ctx);
    const result = await tool.execute({ input: '   ', toolCallId: '1' }, ctx);
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('requires the full patch text');
  });

  test('parse error is reported without mutating anything', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-parse-'));
    const ctx = makeContext();
    const tool = getTool(ctx);
    const result = await tool.execute(
      { input: '*** Begin Patch\ngarbage\n*** End Patch', toolCallId: '1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('not a valid hunk header');
  });

  test('update of a missing file fails before approval', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-missing-'));
    let asked = false;
    const ctx = makeContext(async () => {
      asked = true;
      return 'approve';
    });
    const tool = getTool(ctx);
    const result = await tool.execute(
      {
        input: wrap('*** Update File: nope.txt', '@@', '-x', '+y'),
        toolCallId: '1',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('file not found');
    expect(asked).toBe(false);
  });

  test('workspace escape is rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-escape-'));
    const ctx = makeContext();
    const tool = getTool(ctx);
    const result = await tool.execute(
      {
        input: wrap('*** Add File: ../escape.txt', '+pwned'),
        toolCallId: '1',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('outside workspace root');
  });

  test('opencode-style patchText key is accepted', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-ap-pt-'));
    const ctx = makeContext();
    const tool = getTool(ctx);
    const result = await tool.execute(
      { patchText: wrap('*** Add File: z.txt', '+z'), toolCallId: '1' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(join(workspace, 'z.txt'), 'utf8')).toBe('z\n');
  });
});
