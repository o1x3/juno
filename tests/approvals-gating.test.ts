import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type {
  ApprovalDecision,
  ApprovalPreview,
  ApprovalRequest,
  ToolContext,
  ToolName,
  ToolSpec,
} from '@/types';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'juno-gate-'));
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

type Overrides = Partial<Pick<ToolContext, 'requestApproval'>>;

function makeCtx(overrides: Overrides = {}): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    sessionsDir: join(workspace, 'sessions'),
    sessionId: 's-test',
    ...overrides,
  };
}

function getTool(ctx: ToolContext, name: ToolName): ToolSpec {
  const tool = createBuiltinTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool missing`);
  return tool;
}

function alwaysApprove(seen: ApprovalRequest[]) {
  return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    seen.push(req);
    return 'approve';
  };
}

function alwaysReject(seen: ApprovalRequest[]) {
  return async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    seen.push(req);
    return 'reject';
  };
}

describe('approval gating — back-compat (no callback)', () => {
  test('Write succeeds without a callback', async () => {
    const ctx = makeCtx();
    const tool = getTool(ctx, 'Write');
    const file = join(workspace, 'a.txt');
    const result = await tool.execute(
      { toolCallId: 'c1', filePath: file, content: 'hello' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('hello');
  });

  test('Edit succeeds without a callback', async () => {
    const file = join(workspace, 'b.txt');
    await writeFile(file, 'foo bar', 'utf8');
    const ctx = makeCtx();
    const tool = getTool(ctx, 'Edit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        filePath: file,
        oldString: 'bar',
        newString: 'baz',
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('foo baz');
  });

  test('MultiEdit succeeds without a callback', async () => {
    const file = join(workspace, 'c.txt');
    await writeFile(file, '1 2', 'utf8');
    const ctx = makeCtx();
    const tool = getTool(ctx, 'MultiEdit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        path: file,
        edits: [{ old_string: '1', new_string: 'one' }],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('one 2');
  });

  test('Bash succeeds without a callback', async () => {
    const ctx = makeCtx();
    const tool = getTool(ctx, 'Bash');
    const result = await tool.execute(
      { toolCallId: 'c1', command: 'echo hello' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const output = result.output as { stdout: string; exitCode: number };
    expect(output.stdout).toContain('hello');
    expect(output.exitCode).toBe(0);
  });
});

describe('approval gating — approve', () => {
  test('Write proceeds and the preview includes a diff with created flag', async () => {
    const seen: ApprovalRequest[] = [];
    const ctx = makeCtx({ requestApproval: alwaysApprove(seen) });
    const tool = getTool(ctx, 'Write');
    const file = join(workspace, 'a.txt');
    const result = await tool.execute(
      { toolCallId: 'c1', filePath: file, content: 'hello' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('hello');
    expect(seen[0]?.toolName).toBe('Write');
    expect(seen[0]?.preview.kind).toBe('write');
    const preview = seen[0]?.preview as Extract<
      ApprovalPreview,
      { kind: 'write' }
    >;
    expect(preview.created).toBe(true);
    expect(preview.bytes).toBe(5);
    expect(preview.diff?.created).toBe(true);
  });

  test('Edit proceeds and the preview includes a diff', async () => {
    const file = join(workspace, 'b.txt');
    await writeFile(file, 'foo bar', 'utf8');
    const seen: ApprovalRequest[] = [];
    const ctx = makeCtx({ requestApproval: alwaysApprove(seen) });
    const tool = getTool(ctx, 'Edit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        filePath: file,
        oldString: 'bar',
        newString: 'baz',
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('foo baz');
    expect(seen[0]?.toolName).toBe('Edit');
    const preview = seen[0]?.preview as Extract<
      ApprovalPreview,
      { kind: 'edit' }
    >;
    expect(preview.kind).toBe('edit');
    expect(preview.diff).toBeDefined();
  });

  test('MultiEdit proceeds and the preview includes a diff', async () => {
    const file = join(workspace, 'c.txt');
    await writeFile(file, '1 2', 'utf8');
    const seen: ApprovalRequest[] = [];
    const ctx = makeCtx({ requestApproval: alwaysApprove(seen) });
    const tool = getTool(ctx, 'MultiEdit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        path: file,
        edits: [{ old_string: '1', new_string: 'one' }],
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('one 2');
    expect(seen[0]?.toolName).toBe('MultiEdit');
    const preview = seen[0]?.preview as Extract<
      ApprovalPreview,
      { kind: 'multi-edit' }
    >;
    expect(preview.kind).toBe('multi-edit');
    expect(preview.created).toBe(false);
    expect(preview.diff).toBeDefined();
  });

  test('Bash proceeds and the preview includes the command', async () => {
    const seen: ApprovalRequest[] = [];
    const ctx = makeCtx({ requestApproval: alwaysApprove(seen) });
    const tool = getTool(ctx, 'Bash');
    const result = await tool.execute(
      { toolCallId: 'c1', command: 'echo gated' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    const output = result.output as { stdout: string };
    expect(output.stdout).toContain('gated');
    const preview = seen[0]?.preview as Extract<
      ApprovalPreview,
      { kind: 'bash' }
    >;
    expect(preview.kind).toBe('bash');
    expect(preview.command).toBe('echo gated');
  });

  test('approve_forever is treated as approve by the tool', async () => {
    const ctx = makeCtx({
      requestApproval: async () => 'approve_forever' as ApprovalDecision,
    });
    const tool = getTool(ctx, 'Write');
    const file = join(workspace, 'forever.txt');
    const result = await tool.execute(
      { toolCallId: 'c1', filePath: file, content: 'ok' },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('ok');
  });
});

describe('approval gating — reject', () => {
  test('Write rejection leaves the file untouched', async () => {
    const seen: ApprovalRequest[] = [];
    const ctx = makeCtx({ requestApproval: alwaysReject(seen) });
    const tool = getTool(ctx, 'Write');
    const file = join(workspace, 'reject.txt');
    const result = await tool.execute(
      { toolCallId: 'c1', filePath: file, content: 'hi' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected Write');
    expect(existsSync(file)).toBe(false);
  });

  test('Edit rejection preserves the original content', async () => {
    const file = join(workspace, 'preserve.txt');
    await writeFile(file, 'before', 'utf8');
    const original = await stat(file);
    const ctx = makeCtx({ requestApproval: async () => 'reject' });
    const tool = getTool(ctx, 'Edit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        filePath: file,
        oldString: 'before',
        newString: 'after',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected Edit');
    expect(await readFile(file, 'utf8')).toBe('before');
    const post = await stat(file);
    expect(post.size).toBe(original.size);
  });

  test('MultiEdit rejection preserves the original content', async () => {
    const file = join(workspace, 'mpreserve.txt');
    await writeFile(file, '1 2', 'utf8');
    const ctx = makeCtx({ requestApproval: async () => 'reject' });
    const tool = getTool(ctx, 'MultiEdit');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        path: file,
        edits: [{ old_string: '1', new_string: 'one' }],
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected MultiEdit');
    expect(await readFile(file, 'utf8')).toBe('1 2');
  });

  test('reject with reason: tool error includes the reason text', async () => {
    const ctx = makeCtx({
      requestApproval: async () => ({
        decision: 'reject' as const,
        reason: 'too risky for this branch',
      }),
    });
    const tool = getTool(ctx, 'Write');
    const file = join(workspace, 'with-reason.txt');
    const result = await tool.execute(
      { toolCallId: 'c1', filePath: file, content: 'hi' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected Write');
    expect(String(result.output)).toContain('too risky for this branch');
    expect(existsSync(file)).toBe(false);
  });

  test('Bash rejection skips command execution', async () => {
    // The command would create a sentinel file if executed; we assert absence.
    const sentinel = join(workspace, 'should-not-exist');
    const ctx = makeCtx({ requestApproval: async () => 'reject' });
    const tool = getTool(ctx, 'Bash');
    const result = await tool.execute(
      {
        toolCallId: 'c1',
        command: `touch '${sentinel}'`,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('user rejected Bash');
    expect(existsSync(sentinel)).toBe(false);
  });
});
