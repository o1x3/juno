import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSessionEvent,
  listSessions,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('session persistence', () => {
  test('appends and restores JSONL rollouts', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sessions-'));
    const sessionId = 's1';

    await appendSessionEvent(workspace, sessionId, {
      type: 'user_message',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    });
    await appendSessionEvent(workspace, sessionId, {
      type: 'assistant_message',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: 'hi', toolCalls: [] },
    });

    const events = await readSessionEvents(workspace, sessionId);
    expect(events).toHaveLength(2);
    expect(restoreMessages(events)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', toolCalls: [] },
    ]);
    expect((await listSessions(workspace))[0]?.id).toBe('s1');
  });
});
