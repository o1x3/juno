import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendSessionEvent, readSessionEvents } from '@/core/session-store';
import { SnapshotStore } from '@/core/snapshot';
import { undoLastTurn } from '@/core/undo';

let workspace = '';
let home = '';

afterEach(async () => {
  for (const dir of [workspace, home]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  workspace = '';
  home = '';
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  await proc.exited;
}

describe('undoLastTurn', () => {
  test('no snapshot → not undone', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-undo-ws-'));
    home = await mkdtemp(join(tmpdir(), 'juno-undo-home-'));
    const sessionsDir = join(home, 'sessions');
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'user_message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hi' },
    });
    const res = await undoLastTurn({
      cwd: workspace,
      homeDir: home,
      sessionsDir,
      sessionId: 's1',
    });
    expect(res.undone).toBe(false);
  });

  test('restores files and truncates the session to before the last turn', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-undo-ws-'));
    home = await mkdtemp(join(tmpdir(), 'juno-undo-home-'));
    const sessionsDir = join(home, 'sessions');
    await git(['init'], workspace);

    const fileA = join(workspace, 'a.txt');
    await writeFile(fileA, 'original\n', 'utf8');

    // Turn 1: a prior committed exchange we must keep.
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'user_message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'first turn' },
    });
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'assistant_message',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: 'ok' },
    });

    // Turn 2: snapshot taken at the start, then edits happen.
    const store = new SnapshotStore({ cwd: workspace, homeDir: home });
    const hash = await store.create();
    expect(hash).toBeTruthy();
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'user_message',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: { role: 'user', content: 'second turn' },
    });
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'snapshot',
      timestamp: '2026-01-01T00:01:01.000Z',
      sessionId: 's1',
      hash: hash as string,
    });
    await appendSessionEvent(sessionsDir, 's1', {
      type: 'assistant_message',
      timestamp: '2026-01-01T00:01:02.000Z',
      message: { role: 'assistant', content: 'done editing' },
    });
    await writeFile(fileA, 'CLOBBERED BY TURN 2\n', 'utf8');
    await writeFile(join(workspace, 'new.txt'), 'created in turn 2\n', 'utf8');

    const res = await undoLastTurn({
      cwd: workspace,
      homeDir: home,
      sessionsDir,
      sessionId: 's1',
    });

    expect(res.undone).toBe(true);
    if (!res.undone) return;

    // Filesystem reverted to the pre-turn-2 snapshot.
    expect(await readFile(fileA, 'utf8')).toBe('original\n');

    // Session truncated to before turn 2's user message: only turn 1 remains.
    const events = await readSessionEvents(sessionsDir, 's1');
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('user_message');
    expect(events[1]?.type).toBe('assistant_message');
    expect(res.remainingEvents).toHaveLength(2);
  });
});
