import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startOrResumeChat } from '@/core/chat-service';
import {
  findLatestPlan,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';
import type { SerializedMessage, TodoItem } from '@/types';

import { makeConfig } from './_fixtures';
import { createScriptedModelClient, type ScriptedStep } from './_model-stub';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

type PhasePlan = {
  steps: ScriptedStep[];
  lastTodos: TodoItem[] | undefined;
};

function buildPhase(
  scratchName: string,
  count: number,
  options: {
    editStart: number;
    idTag: string;
    emptyAt?: Set<number>;
  },
): PhasePlan {
  const steps: ScriptedStep[] = [];
  let editCursor = options.editStart;
  let lastTodos: TodoItem[] | undefined;
  for (let i = 0; i < count; i += 1) {
    if (options.emptyAt?.has(i)) {
      steps.push({ kind: 'plain', text: '' });
      continue;
    }
    const cycle = i % 4;
    if (cycle === 0) {
      steps.push({ kind: 'plain', text: `${options.idTag} reply ${i + 1}` });
    } else if (cycle === 1) {
      steps.push({ kind: 'read', filePath: scratchName });
    } else if (cycle === 2) {
      editCursor += 1;
      steps.push({
        kind: 'edit',
        filePath: scratchName,
        oldString: `STATE-${editCursor}`,
        newString: `done-${editCursor}`,
      });
    } else {
      const todos: TodoItem[] = [
        {
          id: `${options.idTag}-t${i + 1}-a`,
          content: `${options.idTag} item ${i + 1} done`,
          status: 'completed',
        },
        {
          id: `${options.idTag}-t${i + 1}-b`,
          content: `${options.idTag} item ${i + 1} ongoing`,
          status: 'in_progress',
        },
      ];
      lastTodos = todos;
      steps.push({ kind: 'todo', todos });
    }
  }
  return { steps, lastTodos };
}

describe('session resume after tool-heavy turns', () => {
  test('30-turn run, then resume for 20 more turns, conversation intact', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-resume-'));
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

    const phase1 = buildPhase(scratchName, 30, {
      editStart: 0,
      idTag: 'phase1',
      emptyAt: new Set([5, 17]),
    });
    const { client: phase1Client, observed: phase1Observed } =
      createScriptedModelClient(phase1.steps, { toolCallPrefix: 'phase1' });

    let sessionId: string | undefined;
    for (let i = 0; i < 30; i += 1) {
      const result = await startOrResumeChat({
        config,
        sessionId,
        prompt: `phase1 turn ${i + 1}`,
        modelClient: phase1Client,
      });
      sessionId = result.sessionId;
    }

    if (!sessionId) throw new Error('phase1 produced no session id');
    expect(phase1.lastTodos).toBeDefined();

    const eventsAfterPhase1 = await readSessionEvents(
      config.sessionsDir,
      sessionId,
    );
    const expectedRestored: SerializedMessage[] =
      restoreMessages(eventsAfterPhase1);

    expect(findLatestPlan(eventsAfterPhase1)).toEqual(
      phase1.lastTodos as TodoItem[],
    );

    const phase2 = buildPhase(scratchName, 20, {
      editStart: 100,
      idTag: 'phase2',
      emptyAt: new Set([7]),
    });
    const { client: phase2Client, observed: phase2Observed } =
      createScriptedModelClient(phase2.steps, { toolCallPrefix: 'phase2' });

    for (let i = 0; i < 20; i += 1) {
      const result = await startOrResumeChat({
        config,
        sessionId,
        prompt: `phase2 turn ${i + 1}`,
        modelClient: phase2Client,
      });
      sessionId = result.sessionId;
    }

    const firstResumeSnapshot = phase2Observed.messagesSeen[0];
    expect(firstResumeSnapshot).toBeDefined();
    if (!firstResumeSnapshot) throw new Error('phase2 stub was never called');

    expect(firstResumeSnapshot.length).toBe(expectedRestored.length + 1);
    for (let i = 0; i < expectedRestored.length; i += 1) {
      expect(firstResumeSnapshot[i]).toEqual(expectedRestored[i]);
    }
    const lastResumeMessage = firstResumeSnapshot.at(-1);
    expect(lastResumeMessage).toEqual({
      role: 'user',
      content: 'phase2 turn 1',
    });

    const userOrder = firstResumeSnapshot
      .filter(
        (m): m is Extract<SerializedMessage, { role: 'user' }> =>
          m.role === 'user',
      )
      .map((m) => m.content);
    for (let i = 0; i < 30; i += 1) {
      expect(userOrder[i]).toBe(`phase1 turn ${i + 1}`);
    }
    expect(userOrder.at(-1)).toBe('phase2 turn 1');

    const eventsAfterPhase2 = await readSessionEvents(
      config.sessionsDir,
      sessionId,
    );

    for (let i = 1; i < eventsAfterPhase2.length; i += 1) {
      const prev = eventsAfterPhase2[i - 1].timestamp;
      const curr = eventsAfterPhase2[i].timestamp;
      if (!(curr >= prev)) {
        throw new Error(
          `non-monotonic timestamp at index ${i}: ${prev} → ${curr}`,
        );
      }
    }

    const ids = new Set<string>();
    const duplicates: string[] = [];
    for (const event of eventsAfterPhase2) {
      if (event.type === 'tool_call') {
        if (ids.has(event.call.toolCallId)) {
          duplicates.push(event.call.toolCallId);
        }
        ids.add(event.call.toolCallId);
      }
    }
    expect(duplicates).toEqual([]);

    const phase1Ids = phase1Observed.toolCallIdsEmitted;
    const phase2Ids = phase2Observed.toolCallIdsEmitted;
    expect(phase1Ids.length).toBeGreaterThan(0);
    expect(phase2Ids.length).toBeGreaterThan(0);
    const overlap = phase1Ids.filter((id) => phase2Ids.includes(id));
    expect(overlap).toEqual([]);

    const planAfterResume = findLatestPlan(eventsAfterPhase2);
    expect(planAfterResume).toBeDefined();
    if (phase2.lastTodos) {
      expect(planAfterResume).toEqual(phase2.lastTodos);
    } else {
      expect(planAfterResume).toEqual(phase1.lastTodos as TodoItem[]);
    }
  });
});
