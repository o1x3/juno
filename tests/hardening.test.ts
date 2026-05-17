// Adversarial / edge-case coverage for the snapshot, compaction, hooks, and
// multi-agent features. These are deliberately trying to break the happy path.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTurn } from '@/core/agent-loop';
import {
  AgentManager,
  type AgentTurnExecutor,
  createMultiAgentTools,
} from '@/core/agent-manager';
import type { AgentDefinition } from '@/core/agents';
import { compactSession } from '@/core/compaction';
import { createHookRunner } from '@/core/hooks';
import {
  appendSessionEvent,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';
import { SnapshotStore } from '@/core/snapshot';
import { undoLastTurn } from '@/core/undo';
import type { ModelClient, SessionEvent, ToolResult } from '@/types';

import { makeConfig } from './_fixtures';

let ws = '';
let home = '';

afterEach(async () => {
  for (const d of [ws, home])
    if (d) await rm(d, { recursive: true, force: true });
  ws = '';
  home = '';
});

async function git(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  await p.exited;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

// ── Snapshot hardening ────────────────────────────────────────────────────

describe('snapshot hardening', () => {
  test('restore handles nested create / subdir modify / delete in one turn', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-snap-ws-'));
    home = await mkdtemp(join(tmpdir(), 'h-snap-hm-'));
    await git(['init'], ws);
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'existing.txt'), 'orig\n', 'utf8');
    await writeFile(join(ws, 'top.txt'), 'top-orig\n', 'utf8');

    const store = new SnapshotStore({ cwd: ws, homeDir: home });
    const hash = await store.create();
    expect(hash).toBeTruthy();

    await writeFile(join(ws, 'src', 'existing.txt'), 'CHANGED\n', 'utf8');
    await rm(join(ws, 'top.txt'));
    await mkdir(join(ws, 'src', 'deep', 'deeper'), { recursive: true });
    await writeFile(
      join(ws, 'src', 'deep', 'deeper', 'new.txt'),
      'created\n',
      'utf8',
    );

    const r = await store.restore(hash as string);
    expect(r.ok).toBe(true);
    expect(await readFile(join(ws, 'src', 'existing.txt'), 'utf8')).toBe(
      'orig\n',
    );
    expect(await readFile(join(ws, 'top.txt'), 'utf8')).toBe('top-orig\n');
    expect(existsSync(join(ws, 'src', 'deep'))).toBe(false);
  });

  test('restore with a garbage hash fails cleanly', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-snap-ws-'));
    home = await mkdtemp(join(tmpdir(), 'h-snap-hm-'));
    await git(['init'], ws);
    const store = new SnapshotStore({ cwd: ws, homeDir: home });
    await store.create();
    const r = await store.restore('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  test('undo does NOT truncate the session when filesystem restore fails', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-undo-ws-'));
    home = await mkdtemp(join(tmpdir(), 'h-undo-hm-'));
    const sessionsDir = join(home, 'sessions');
    await git(['init'], ws);
    await appendSessionEvent(sessionsDir, 's', {
      type: 'user_message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'go' },
    });
    await appendSessionEvent(sessionsDir, 's', {
      type: 'snapshot',
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 's',
      hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    const res = await undoLastTurn({
      cwd: ws,
      homeDir: home,
      sessionsDir,
      sessionId: 's',
    });
    expect(res.undone).toBe(false);
    const events = await readSessionEvents(sessionsDir, 's');
    expect(events).toHaveLength(2); // untouched
  });

  test('repeated undo walks back turn by turn', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-undo-ws-'));
    home = await mkdtemp(join(tmpdir(), 'h-undo-hm-'));
    const sessionsDir = join(home, 'sessions');
    await git(['init'], ws);
    const file = join(ws, 'f.txt');
    const store = new SnapshotStore({ cwd: ws, homeDir: home });

    await writeFile(file, 'v0\n', 'utf8');
    // Turn 1
    await appendSessionEvent(sessionsDir, 's', {
      type: 'user_message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 't1' },
    });
    await appendSessionEvent(sessionsDir, 's', {
      type: 'snapshot',
      timestamp: '2026-01-01T00:00:01.000Z',
      sessionId: 's',
      hash: (await store.create()) as string,
    });
    await writeFile(file, 'v1\n', 'utf8');
    // Turn 2
    await appendSessionEvent(sessionsDir, 's', {
      type: 'user_message',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: { role: 'user', content: 't2' },
    });
    await appendSessionEvent(sessionsDir, 's', {
      type: 'snapshot',
      timestamp: '2026-01-01T00:01:01.000Z',
      sessionId: 's',
      hash: (await store.create()) as string,
    });
    await writeFile(file, 'v2\n', 'utf8');

    const u1 = await undoLastTurn({
      cwd: ws,
      homeDir: home,
      sessionsDir,
      sessionId: 's',
    });
    expect(u1.undone).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v1\n');

    const u2 = await undoLastTurn({
      cwd: ws,
      homeDir: home,
      sessionsDir,
      sessionId: 's',
    });
    expect(u2.undone).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('v0\n');
    expect(await readSessionEvents(sessionsDir, 's')).toHaveLength(0);
  });
});

// ── Compaction hardening ──────────────────────────────────────────────────

function uEvent(c: string): SessionEvent {
  return {
    type: 'user_message',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: c },
  };
}
function aEvent(c: string): SessionEvent {
  return {
    type: 'assistant_message',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: c },
  };
}

describe('compaction hardening', () => {
  test('chained compaction folds the prior summary into the new one', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-comp-'));
    const sessionsDir = join(ws, 'sessions');
    const sid = 's';
    for (let i = 0; i < 4; i += 1) {
      await appendSessionEvent(
        sessionsDir,
        sid,
        uEvent(`u${i} ${'x'.repeat(300)}`),
      );
      await appendSessionEvent(
        sessionsDir,
        sid,
        aEvent(`a${i} ${'y'.repeat(300)}`),
      );
    }
    const client: ModelClient = {
      async runStep({ messages }) {
        // Echo back something that proves what was summarized.
        const joined = messages
          .map((m) => ('content' in m ? m.content : ''))
          .join('|');
        return {
          text: `SUMMARY[len=${joined.length}]`,
          toolCalls: [],
          finishReason: 'stop',
          usage: { input: 1, output: 1 },
        };
      },
    };
    const first = await compactSession({
      sessionsDir,
      sessionId: sid,
      modelClient: client,
      model: 'm',
      keepRecentTokens: 50,
      force: true,
      buildMessages: restoreMessages,
    });
    expect(first.compacted).toBe(true);
    let events = await readSessionEvents(sessionsDir, sid);
    expect(events.filter((e) => e.type === 'compaction')).toHaveLength(1);

    // More turns, then compact again.
    for (let i = 4; i < 7; i += 1) {
      await appendSessionEvent(
        sessionsDir,
        sid,
        uEvent(`u${i} ${'z'.repeat(300)}`),
      );
      await appendSessionEvent(
        sessionsDir,
        sid,
        aEvent(`a${i} ${'w'.repeat(300)}`),
      );
    }
    const second = await compactSession({
      sessionsDir,
      sessionId: sid,
      modelClient: client,
      model: 'm',
      keepRecentTokens: 50,
      force: true,
      buildMessages: restoreMessages,
    });
    expect(second.compacted).toBe(true);
    events = await readSessionEvents(sessionsDir, sid);
    // Still exactly one marker (rewrite replaced, not appended).
    expect(events.filter((e) => e.type === 'compaction')).toHaveLength(1);
    expect(events[0]?.type).toBe('compaction');
    const messages = restoreMessages(events);
    expect(messages[0]?.role).toBe('user');
    expect((messages[0] as { content: string }).content).toContain('SUMMARY[');
  });

  test('keeps an incomplete tool turn in the tail without crashing', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-comp-'));
    const sessionsDir = join(ws, 'sessions');
    const sid = 's';
    await appendSessionEvent(
      sessionsDir,
      sid,
      uEvent(`old ${'x'.repeat(600)}`),
    );
    await appendSessionEvent(
      sessionsDir,
      sid,
      aEvent(`reply ${'y'.repeat(600)}`),
    );
    await appendSessionEvent(sessionsDir, sid, uEvent('recent turn'));
    await appendSessionEvent(sessionsDir, sid, {
      type: 'assistant_message',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ toolCallId: 'x1', toolName: 'Read', input: {} }],
      },
    });
    // No matching tool_result — interrupted mid-tool.
    const client: ModelClient = {
      async runStep() {
        return {
          text: 'S',
          toolCalls: [],
          finishReason: 'stop',
          usage: { input: 1, output: 1 },
        };
      },
    };
    const r = await compactSession({
      sessionsDir,
      sessionId: sid,
      modelClient: client,
      model: 'm',
      keepRecentTokens: 5,
      force: false,
      buildMessages: restoreMessages,
    });
    expect(r.compacted).toBe(true);
    const events = await readSessionEvents(sessionsDir, sid);
    const messages = restoreMessages(events);
    // Synthesized interrupted result must still parse.
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
  });

  test('compaction never orphans a tool call across the summary boundary', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-comp-'));
    const sessionsDir = join(ws, 'sessions');
    const sid = 's';
    // Two complete tool turns then a fresh recent turn. A naive cut could
    // split an assistant(toolCalls) from its tool_result — assert it doesn't.
    for (let t = 0; t < 3; t += 1) {
      await appendSessionEvent(
        sessionsDir,
        sid,
        uEvent(`turn ${t} ${'q'.repeat(400)}`),
      );
      await appendSessionEvent(sessionsDir, sid, {
        type: 'assistant_message',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { toolCallId: `c${t}`, toolName: 'Read', input: { f: t } },
          ],
        },
      });
      await appendSessionEvent(sessionsDir, sid, {
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        result: {
          toolCallId: `c${t}`,
          toolName: 'Read',
          output: `data ${t} ${'r'.repeat(400)}`,
        },
      });
    }
    const client: ModelClient = {
      async runStep() {
        return {
          text: 'SUM',
          toolCalls: [],
          finishReason: 'stop',
          usage: { input: 1, output: 1 },
        };
      },
    };
    const r = await compactSession({
      sessionsDir,
      sessionId: sid,
      modelClient: client,
      model: 'm',
      keepRecentTokens: 60,
      force: true,
      buildMessages: restoreMessages,
    });
    expect(r.compacted).toBe(true);
    const messages = restoreMessages(await readSessionEvents(sessionsDir, sid));
    // Every assistant tool call id must have a matching tool result id.
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'assistant')
        for (const c of m.toolCalls ?? []) callIds.add(c.toolCallId);
      if (m.role === 'tool')
        for (const res of m.results) resultIds.add(res.toolCallId);
    }
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
  });
});

// ── Hooks hardening ───────────────────────────────────────────────────────

describe('hooks hardening', () => {
  test('continue:false stops with stopReason', async () => {
    const runner = createHookRunner({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'c' }] }] },
      sessionId: 's',
      cwd: '/tmp',
      spawn: async () => ({
        code: 0,
        stdout: JSON.stringify({ continue: false, stopReason: 'halt now' }),
        stderr: '',
      }),
    });
    const d = await runner.stop();
    expect(d.block).toBe(true);
    expect(d.reason).toBe('halt now');
  });

  test('second matcher can block when the first allows', async () => {
    const runner = createHookRunner({
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'a' }] },
          { matcher: 'Write', hooks: [{ type: 'command', command: 'b' }] },
        ],
      },
      sessionId: 's',
      cwd: '/tmp',
      spawn: async (command) =>
        command === 'b'
          ? { code: 2, stdout: '', stderr: 'second says no' }
          : { code: 0, stdout: '', stderr: '' },
    });
    const d = await runner.preToolUse('Write', {});
    expect(d.block).toBe(true);
    expect(d.reason).toBe('second says no');
  });

  test('PostToolUse additionalContext is appended to the tool output', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-hook-'));
    const config = makeConfig(ws);
    let n = 0;
    const modelClient: ModelClient = {
      async runStep() {
        n += 1;
        if (n === 1) {
          return {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 'c1',
                toolName: 'Write',
                input: { filePath: 'a.txt', content: 'hi' },
              },
            ],
          };
        }
        return { text: 'ok', finishReason: 'stop', toolCalls: [] };
      },
    };
    const runner = createHookRunner({
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'p' }] }],
      },
      sessionId: 's',
      cwd: ws,
      spawn: async () => ({
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { additionalContext: 'linted clean' },
        }),
        stderr: '',
      }),
    });
    const { createBuiltinTools } = await import('@/core/tools');
    const result = await runAgentTurn({
      config,
      sessionId: 's',
      model: 'm',
      systemPrompt: 'sys',
      userInput: 'write',
      messages: [],
      tools: createBuiltinTools({
        cwd: ws,
        outputLimit: 1000,
        readLineLimit: 50,
        bashTimeoutMs: 1000,
        sessionsDir: join(ws, 'sessions'),
        sessionId: 's',
      }),
      modelClient,
      hooks: runner,
    });
    expect(String(result.toolResults[0]?.output)).toContain('linted clean');
  });

  test('Stop hook re-opens the turn but the budget is bounded', async () => {
    ws = await mkdtemp(join(tmpdir(), 'h-hook-'));
    const config = makeConfig(ws, { maxSteps: 20 });
    let calls = 0;
    const modelClient: ModelClient = {
      async runStep() {
        calls += 1;
        return { text: `r${calls}`, finishReason: 'stop', toolCalls: [] };
      },
    };
    const runner = createHookRunner({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keepgoing' }] }] },
      sessionId: 's',
      cwd: ws,
      spawn: async () => ({ code: 2, stdout: '', stderr: 'not done yet' }),
    });
    await runAgentTurn({
      config,
      sessionId: 's',
      model: 'm',
      systemPrompt: 'sys',
      userInput: 'go',
      messages: [],
      tools: [],
      modelClient,
      hooks: runner,
    });
    // 1 initial + STOP_HOOK_BUDGET (3) re-openings = 4, then forced stop.
    expect(calls).toBe(4);
  });
});

// ── Multi-agent hardening ─────────────────────────────────────────────────

const GENERAL: AgentDefinition = {
  name: 'general',
  description: 'g',
  prompt: 'p',
  source: 'builtin',
};

function mgrWith(executor: AgentTurnExecutor): AgentManager {
  return new AgentManager({
    executor,
    resolveAgentDef: (t) => (t === 'general' ? GENERAL : undefined),
  });
}

describe('multi-agent hardening', () => {
  test('no lost wakeup: messages queued while running are all processed in order', async () => {
    const processed: string[] = [];
    let gate: (() => void) | undefined;
    const mgr = mgrWith(async ({ prompt, history }) => {
      processed.push(prompt);
      if (processed.length === 1) {
        await new Promise<void>((r) => {
          gate = r;
        });
      }
      return { text: prompt, history, toolCalls: 0 };
    });
    const res = mgr.spawn({ message: 'm0', agentType: 'general' });
    if (!res.ok) return;
    // While the first turn is parked on the gate, enqueue more.
    await tick();
    mgr.sendInput({ target: res.id, message: 'm1' });
    mgr.sendInput({ target: res.id, message: 'm2' });
    mgr.sendInput({ target: res.id, message: 'm3' });
    gate?.();
    for (let i = 0; i < 60 && processed.length < 4; i += 1) await tick();
    expect(processed).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  test('duplicate live task_name rejected; reusable after close', () => {
    const mgr = mgrWith(async ({ history }) => ({
      text: '',
      history,
      toolCalls: 0,
    }));
    const a = mgr.spawn({ message: 'x', taskName: 'worker' });
    expect(a.ok).toBe(true);
    const dup = mgr.spawn({ message: 'y', taskName: 'worker' });
    expect(dup.ok).toBe(false);
    if (a.ok) mgr.close(a.id);
    const reuse = mgr.spawn({ message: 'z', taskName: 'worker' });
    expect(reuse.ok).toBe(true);
  });

  test('invalid task_name characters are rejected', () => {
    const mgr = mgrWith(async ({ history }) => ({
      text: '',
      history,
      toolCalls: 0,
    }));
    expect(mgr.spawn({ message: 'x', taskName: 'Bad Name!' }).ok).toBe(false);
  });

  test('v2 spawn_agent without task_name returns an error result', async () => {
    const mgr = mgrWith(async ({ history }) => ({
      text: '',
      history,
      toolCalls: 0,
    }));
    const spawn = createMultiAgentTools(mgr, 'v2', ['general']).find(
      (t) => t.name === 'spawn_agent',
    );
    const r = (await spawn?.execute(
      { message: 'hi', toolCallId: 't' },
      {} as never,
    )) as ToolResult;
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('task_name is required');
  });

  test('send_input resumes a completed agent with prior context', async () => {
    const seen: Array<{ p: string; h: number }> = [];
    const mgr = mgrWith(async ({ prompt, history }) => {
      seen.push({ p: prompt, h: history.length });
      return {
        text: prompt,
        history: [
          ...history,
          { role: 'user', content: prompt },
          { role: 'assistant', content: 'done' },
        ],
        toolCalls: 0,
      };
    });
    const res = mgr.spawn({ message: 'first', agentType: 'general' });
    if (!res.ok) return;
    for (let i = 0; i < 40; i += 1) {
      await tick();
      const s = await mgr.waitV1([res.id], 1);
      const st = s.status[res.id];
      if (st && typeof st === 'object' && 'completed' in st) break;
    }
    mgr.sendInput({ target: res.id, message: 'second' });
    for (let i = 0; i < 40 && seen.length < 2; i += 1) await tick();
    expect(seen[0]).toEqual({ p: 'first', h: 0 });
    expect(seen[1]).toEqual({ p: 'second', h: 2 });
  });

  test('close mid-flight keeps shutdown even after the executor returns', async () => {
    let release: (() => void) | undefined;
    const mgr = mgrWith(async ({ history }) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { text: 'late', history, toolCalls: 0 };
    });
    const res = mgr.spawn({ message: 'work', agentType: 'general' });
    if (!res.ok) return;
    await tick();
    const closed = mgr.close(res.id);
    expect(closed.ok).toBe(true);
    release?.();
    await tick();
    await tick();
    // Status must remain shutdown, not flip to completed.
    const s = await mgr.waitV1([res.id], 5);
    expect(s.status[res.id]).toBe('shutdown');
  });
});
