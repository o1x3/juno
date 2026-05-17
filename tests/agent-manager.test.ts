import { describe, expect, test } from 'bun:test';

import {
  AgentManager,
  type AgentTurnExecutor,
  createMultiAgentTools,
  MAX_CONCURRENT_AGENTS,
} from '@/core/agent-manager';
import type { AgentDefinition } from '@/core/agents';
import type { ToolResult } from '@/types';

const GENERAL: AgentDefinition = {
  name: 'general',
  description: 'general',
  prompt: 'you are general',
  source: 'builtin',
};

function managerWith(executor: AgentTurnExecutor): AgentManager {
  return new AgentManager({
    executor,
    resolveAgentDef: (type) => (type === 'general' ? GENERAL : undefined),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('AgentManager', () => {
  test('spawn runs the executor and reaches completed', async () => {
    const seen: string[] = [];
    const mgr = managerWith(async ({ prompt, history }) => {
      seen.push(prompt);
      return {
        text: `did: ${prompt}`,
        history: [...history, { role: 'user', content: prompt }],
        toolCalls: 0,
      };
    });
    const res = mgr.spawn({ message: 'task one', agentType: 'general' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Drain the background turn.
    for (let i = 0; i < 20; i += 1) {
      await tick();
      const list = mgr.list();
      if (
        list[0] &&
        typeof list[0].agent_status === 'object' &&
        'completed' in list[0].agent_status
      )
        break;
    }
    const list = mgr.list();
    expect(seen).toEqual(['task one']);
    expect(list[0]?.agent_status).toEqual({ completed: 'did: task one' });
  });

  test('send_input continues the same agent with prior history', async () => {
    const historiesSeen: number[] = [];
    const mgr = managerWith(async ({ prompt, history }) => {
      historiesSeen.push(history.length);
      return {
        text: prompt,
        history: [
          ...history,
          { role: 'user', content: prompt },
          { role: 'assistant', content: 'ok' },
        ],
        toolCalls: 0,
      };
    });
    const res = mgr.spawn({ message: 'first', agentType: 'general' });
    if (!res.ok) return;
    await waitDone(mgr, res.id);
    const sent = mgr.sendInput({ target: res.id, message: 'second' });
    expect(sent.ok).toBe(true);
    await waitDone(mgr, res.id);
    // First turn saw empty history; second saw the 2 messages from the first.
    expect(historiesSeen).toEqual([0, 2]);
  });

  test('waitV1 returns completed status; waitV1 times out on a hung agent', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = managerWith(async ({ prompt, history }) => {
      await gate;
      return { text: prompt, history, toolCalls: 0 };
    });
    const res = mgr.spawn({ message: 'slow', agentType: 'general' });
    if (!res.ok) return;

    const timedOut = await mgr.waitV1([res.id], 50);
    expect(timedOut.timed_out).toBe(true);
    expect(timedOut.status[res.id]).toBe('running');

    release?.();
    const done = await mgr.waitV1([res.id], 2000);
    expect(done.timed_out).toBe(false);
    expect(done.status[res.id]).toEqual({ completed: 'slow' });
  });

  test('waitV1 reports not_found for unknown targets', async () => {
    const mgr = managerWith(async ({ history }) => ({
      text: '',
      history,
      toolCalls: 0,
    }));
    const r = await mgr.waitV1(['nope'], 20);
    expect(r.status.nope).toBe('not_found');
  });

  test('close returns previous status and frees a slot; list hides it', async () => {
    const mgr = managerWith(async ({ history }) => ({
      text: 'x',
      history,
      toolCalls: 0,
    }));
    const res = mgr.spawn({ message: 'work', agentType: 'general' });
    if (!res.ok) return;
    const closed = mgr.close(res.id);
    expect(closed.ok).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });

  test('enforces the concurrency cap', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mgr = managerWith(async ({ history }) => {
      await gate;
      return { text: '', history, toolCalls: 0 };
    });
    for (let i = 0; i < MAX_CONCURRENT_AGENTS; i += 1) {
      expect(mgr.spawn({ message: `m${i}`, agentType: 'general' }).ok).toBe(
        true,
      );
    }
    const over = mgr.spawn({ message: 'too many', agentType: 'general' });
    expect(over.ok).toBe(false);
    release?.();
  });

  test('unknown agent_type is rejected', () => {
    const mgr = managerWith(async ({ history }) => ({
      text: '',
      history,
      toolCalls: 0,
    }));
    const r = mgr.spawn({ message: 'x', agentType: 'nope' });
    expect(r.ok).toBe(false);
  });
});

async function waitDone(mgr: AgentManager, id: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await tick();
    const s = await mgr.waitV1([id], 1);
    const st = s.status[id];
    if (st && typeof st === 'object' && 'completed' in st) return;
  }
}

describe('createMultiAgentTools', () => {
  function out(r: ToolResult): Record<string, unknown> {
    return r.output as Record<string, unknown>;
  }

  test('v2 spawn requires task_name and returns task_name', async () => {
    const mgr = managerWith(async ({ history }) => ({
      text: 'done',
      history,
      toolCalls: 0,
    }));
    const tools = createMultiAgentTools(mgr, 'v2', ['general']);
    const spawn = tools.find((t) => t.name === 'spawn_agent');
    expect(spawn).toBeTruthy();
    // Schema enforces task_name in v2.
    expect(spawn?.inputSchema.safeParse({ message: 'hi' }).success).toBe(false);
    const r = await spawn?.execute(
      { task_name: 'my_task', message: 'hi', toolCallId: 't1' },
      {} as never,
    );
    expect(out(r as ToolResult)).toHaveProperty('task_name', 'my_task');
  });

  test('v1 spawn returns agent_id and exposes the five tools', async () => {
    const mgr = managerWith(async ({ history }) => ({
      text: 'done',
      history,
      toolCalls: 0,
    }));
    const tools = createMultiAgentTools(mgr, 'v1', ['general']);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'close_agent',
      'list_agents',
      'send_input',
      'spawn_agent',
      'wait_agent',
    ]);
    const spawn = tools.find((t) => t.name === 'spawn_agent');
    const r = (await spawn?.execute(
      { message: 'go', toolCallId: 't1' },
      {} as never,
    )) as ToolResult;
    expect(out(r)).toHaveProperty('agent_id');
    expect(String(out(r).agent_id)).toStartWith('agent-');
  });
});
