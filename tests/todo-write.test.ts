import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findLatestPlan, readSessionEvents } from '@/core/session-store';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function makeCtx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    sessionsDir: join(workspace, 'sessions'),
    sessionId: 's-test',
  };
}

function getTodoWrite(ctx: ToolContext): ToolSpec {
  const tool = createBuiltinTools(ctx).find((t) => t.name === 'TodoWrite');
  if (!tool) throw new Error('TodoWrite tool missing');
  return tool;
}

describe('TodoWrite', () => {
  test('writes a todo_update event on success', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-todo-'));
    const ctx = makeCtx();
    const tool = getTodoWrite(ctx);

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        todos: [
          { id: 'a', content: 'first task', status: 'in_progress' },
          { id: 'b', content: 'second task', status: 'pending' },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const events = await readSessionEvents(ctx.sessionsDir, ctx.sessionId);
    const last = events.at(-1);
    expect(last?.type).toBe('todo_update');
    if (last?.type !== 'todo_update') throw new Error('unreachable');
    expect(last.todos).toHaveLength(2);
    expect(last.todos[0]?.status).toBe('in_progress');
  });

  test('rejects multiple in_progress items', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-todo-'));
    const ctx = makeCtx();
    const tool = getTodoWrite(ctx);

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        todos: [
          { id: 'a', content: 'one', status: 'in_progress' },
          { id: 'b', content: 'two', status: 'in_progress' },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('in_progress');
  });

  test('accepts empty list (clears the plan)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-todo-'));
    const ctx = makeCtx();
    const tool = getTodoWrite(ctx);

    const result = await tool.execute({ toolCallId: 'c1', todos: [] }, ctx);

    expect(result.isError).toBeUndefined();
    const events = await readSessionEvents(ctx.sessionsDir, ctx.sessionId);
    expect(findLatestPlan(events)).toEqual([]);
  });

  test('findLatestPlan returns the latest update', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-todo-'));
    const ctx = makeCtx();
    const tool = getTodoWrite(ctx);

    await tool.execute(
      {
        toolCallId: 'c1',
        todos: [{ id: 'a', content: 'first', status: 'pending' }],
      },
      ctx,
    );
    await tool.execute(
      {
        toolCallId: 'c2',
        todos: [
          { id: 'a', content: 'first', status: 'completed' },
          { id: 'b', content: 'second', status: 'in_progress' },
        ],
      },
      ctx,
    );

    const events = await readSessionEvents(ctx.sessionsDir, ctx.sessionId);
    const latest = findLatestPlan(events);
    expect(latest).toHaveLength(2);
    expect(latest?.[0]?.status).toBe('completed');
    expect(latest?.[1]?.id).toBe('b');
  });

  test('rejects malformed input without crashing', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-todo-'));
    const ctx = makeCtx();
    const tool = getTodoWrite(ctx);

    const missingArr = await tool.execute({ toolCallId: 'c1' }, ctx);
    expect(missingArr.isError).toBe(true);

    const badStatus = await tool.execute(
      {
        toolCallId: 'c2',
        todos: [{ id: 'a', content: 'x', status: 'nope' }],
      },
      ctx,
    );
    expect(badStatus.isError).toBe(true);

    const duplicate = await tool.execute(
      {
        toolCallId: 'c3',
        todos: [
          { id: 'a', content: 'x', status: 'pending' },
          { id: 'a', content: 'y', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(duplicate.isError).toBe(true);
    expect(String(duplicate.output)).toContain('duplicate');
  });
});
