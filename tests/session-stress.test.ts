import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startOrResumeChat } from '@/core/chat-service';
import { findLatestPlan, readSessionEvents } from '@/core/session-store';
import type { SessionEvent, TodoItem } from '@/types';

import { makeConfig } from './_fixtures';
import { createScriptedModelClient, type ScriptedStep } from './_model-stub';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('long multi-turn session stress', () => {
  test('60 mixed-action turns persist a clean monotone JSONL', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-stress-'));
    const config = makeConfig(workspace, { maxSteps: 6 });

    const scratchName = 'scratch.txt';
    const seedLines = Array.from(
      { length: 30 },
      (_, idx) => `STATE-${idx + 1}`,
    );
    await writeFile(
      join(workspace, scratchName),
      `${seedLines.join('\n')}\n`,
      'utf8',
    );

    const turns = 60;
    const emptyAt = new Set([6, 22, 40]);
    const steps: ScriptedStep[] = [];
    let editCounter = 0;
    let lastTodos: TodoItem[] | undefined;

    for (let i = 0; i < turns; i += 1) {
      if (emptyAt.has(i)) {
        steps.push({ kind: 'plain', text: '' });
        continue;
      }
      const cycle = i % 4;
      if (cycle === 0) {
        steps.push({ kind: 'plain', text: `assistant reply ${i + 1}` });
      } else if (cycle === 1) {
        steps.push({ kind: 'read', filePath: scratchName });
      } else if (cycle === 2) {
        editCounter += 1;
        steps.push({
          kind: 'edit',
          filePath: scratchName,
          oldString: `STATE-${editCounter}`,
          newString: `done-${editCounter}`,
        });
      } else {
        const todos: TodoItem[] = [
          {
            id: `t${i + 1}-a`,
            content: `step ${i + 1} done`,
            status: 'completed',
          },
          {
            id: `t${i + 1}-b`,
            content: `step ${i + 1} ongoing`,
            status: 'in_progress',
            activeForm: `doing step ${i + 1}`,
          },
        ];
        lastTodos = todos;
        steps.push({ kind: 'todo', todos });
      }
    }

    const { client } = createScriptedModelClient(steps);

    const start = performance.now();
    let sessionId: string | undefined;
    for (let i = 0; i < turns; i += 1) {
      const result = await startOrResumeChat({
        config,
        sessionId,
        prompt: `user prompt ${i + 1}`,
        modelClient: client,
      });
      sessionId = result.sessionId;
    }
    const elapsedMs = performance.now() - start;

    if (!sessionId) throw new Error('expected a session id after the run');

    const events = await readSessionEvents(config.sessionsDir, sessionId);

    expect(events.length).toBeGreaterThan(turns);

    for (let i = 1; i < events.length; i += 1) {
      const prev = events[i - 1].timestamp;
      const curr = events[i].timestamp;
      if (!(curr >= prev)) {
        throw new Error(
          `non-monotonic timestamp at index ${i}: ${prev} → ${curr}`,
        );
      }
    }

    const openCalls = new Map<string, SessionEvent>();
    const orphanResults: string[] = [];
    let toolCallCount = 0;
    for (const event of events) {
      if (event.type === 'tool_call') {
        openCalls.set(event.call.toolCallId, event);
        toolCallCount += 1;
      } else if (event.type === 'tool_result') {
        const matched = openCalls.delete(event.result.toolCallId);
        if (!matched) orphanResults.push(event.result.toolCallId);
      }
    }
    expect(orphanResults).toEqual([]);
    expect(openCalls.size).toBe(0);
    expect(toolCallCount).toBeGreaterThan(0);

    expect(lastTodos).toBeDefined();
    expect(findLatestPlan(events)).toEqual(lastTodos as TodoItem[]);

    const fileSize = (
      await stat(join(config.sessionsDir, `${sessionId}.jsonl`))
    ).size;
    expect(fileSize).toBeLessThan(1_000_000);

    if (elapsedMs > 5000) {
      console.error(
        `session-stress: 60 turns took ${elapsedMs.toFixed(0)}ms (budget 5000ms)`,
      );
    }
    expect(elapsedMs).toBeLessThan(30_000);
  });
});
