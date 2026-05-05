import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSessionEvent,
  appendSessionMeta,
  findSessionName,
  listSessions,
  readSessionEvents,
} from '@/core/session-store';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('session_meta event', () => {
  test('appendSessionMeta writes a session_meta event', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-name-'));
    const sessionsDir = join(workspace, 'sessions');
    await appendSessionEvent(sessionsDir, 'sess', {
      type: 'status_meta',
      timestamp: new Date().toISOString(),
      status: 'session_started',
      sessionId: 'sess',
      cwd: workspace,
      model: 'fake',
    });
    await appendSessionMeta(sessionsDir, 'sess', 'refactor-tokens', 'auto');
    const events = await readSessionEvents(sessionsDir, 'sess');
    expect(findSessionName(events)).toBe('refactor-tokens');
  });

  test('listSessions surfaces the session name', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-name-'));
    const sessionsDir = join(workspace, 'sessions');
    await appendSessionEvent(sessionsDir, 's2', {
      type: 'status_meta',
      timestamp: new Date().toISOString(),
      status: 'session_started',
      sessionId: 's2',
      cwd: workspace,
      model: 'fake',
    });
    await appendSessionMeta(sessionsDir, 's2', 'wire-version-flag', 'manual');
    const list = await listSessions(sessionsDir);
    const found = list.find((s) => s.id === 's2');
    expect(found?.name).toBe('wire-version-flag');
  });

  test('latest session_meta wins', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-name-'));
    const sessionsDir = join(workspace, 'sessions');
    await appendSessionEvent(sessionsDir, 's3', {
      type: 'status_meta',
      timestamp: new Date().toISOString(),
      status: 'session_started',
      sessionId: 's3',
      cwd: workspace,
      model: 'fake',
    });
    await appendSessionMeta(sessionsDir, 's3', 'first-name', 'auto');
    await appendSessionMeta(sessionsDir, 's3', 'second-name', 'manual');
    const events = await readSessionEvents(sessionsDir, 's3');
    expect(findSessionName(events)).toBe('second-name');
  });
});
