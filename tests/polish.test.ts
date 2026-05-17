// Coverage for the polish pass: atomic JSONL rewrites, hook timeout
// reporting, and auto-task-name uniqueness.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentManager } from '@/core/agent-manager';
import type { AgentDefinition } from '@/core/agents';
import { atomicWrite } from '@/core/fs';
import { createHookRunner } from '@/core/hooks';

let dir = '';

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('atomicWrite', () => {
  test('writes content and leaves no temp files behind', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-'));
    const target = join(dir, 'nested', 's.jsonl');
    await atomicWrite(target, 'line1\nline2\n');
    expect(await readFile(target, 'utf8')).toBe('line1\nline2\n');
    const entries = await readdir(join(dir, 'nested'));
    expect(entries).toEqual(['s.jsonl']);
  });

  test('overwrite replaces previous content wholesale', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-'));
    const target = join(dir, 's.jsonl');
    await atomicWrite(target, 'OLD-AND-LONGER-CONTENT\n');
    await atomicWrite(target, 'new\n');
    expect(await readFile(target, 'utf8')).toBe('new\n');
    // No stray *.tmp siblings.
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  test('empty content yields an empty file (truncation case)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aw-'));
    const target = join(dir, 's.jsonl');
    await atomicWrite(target, 'something\n');
    await atomicWrite(target, '');
    expect(existsSync(target)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('');
  });
});

describe('hook timeout reporting', () => {
  test('a hook that exceeds its timeout is reported, not parsed as output', async () => {
    const runner = createHookRunner({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'sleep 5', timeout: 1 }] },
        ],
      },
      sessionId: 's',
      cwd: process.cwd(),
      // exercise the real defaultSpawn timeout path (timeout: 1s)
    });
    const start = Date.now();
    const d = await runner.preToolUse('Bash', { command: 'x' });
    // Must return ~at the 1s deadline, NOT wait the full 5s sleep (the bug:
    // killing `sh` doesn't free the stdout pipe held by the `sleep` child).
    expect(Date.now() - start).toBeLessThan(3000);
    // Timeout is a non-blocking soft error (code 1), not a hard block.
    expect(d.block).toBe(false);
  }, 10_000);
});

const GENERAL: AgentDefinition = {
  name: 'general',
  description: 'g',
  prompt: 'p',
  source: 'builtin',
};

describe('auto task_name uniqueness', () => {
  test('auto-generated names skip a name the user explicitly took', () => {
    const mgr = new AgentManager({
      executor: async ({ history }) => ({
        text: '',
        history,
        toolCalls: 0,
      }),
      resolveAgentDef: (t) => (t === 'general' ? GENERAL : undefined),
    });
    // User explicitly grabs "task_1".
    const a = mgr.spawn({ message: 'x', taskName: 'task_1' });
    expect(a.ok).toBe(true);
    // Next two auto-named agents must not collide with task_1.
    const b = mgr.spawn({ message: 'y' });
    const c = mgr.spawn({ message: 'z' });
    expect(b.ok && c.ok).toBe(true);
    const names = mgr.list().map((x) => x.agent_name);
    expect(new Set(names).size).toBe(names.length); // all unique
    expect(names).toContain('task_1');
  });
});
