import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compactSession,
  estimateConversationTokens,
  findCutEventIndex,
  shouldCompact,
} from '@/core/compaction';
import {
  appendSessionEvent,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';
import type { ModelClient, SerializedMessage, SessionEvent } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function fixedSummaryClient(summary: string): ModelClient {
  return {
    async runStep() {
      return {
        text: summary,
        toolCalls: [],
        finishReason: 'stop',
        usage: { input: 1, output: 1 },
      };
    },
  };
}

function userEvent(content: string): SessionEvent {
  return {
    type: 'user_message',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
  };
}

function assistantEvent(content: string): SessionEvent {
  return {
    type: 'assistant_message',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content },
  };
}

describe('compaction estimates', () => {
  test('estimateConversationTokens ~ chars/4', () => {
    const msgs: SerializedMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(40) },
    ];
    expect(estimateConversationTokens(msgs)).toBe(20);
  });

  test('shouldCompact triggers above window minus reserve', () => {
    expect(shouldCompact(100, 200, 50)).toBe(false);
    expect(shouldCompact(160, 200, 50)).toBe(true);
  });
});

describe('findCutEventIndex', () => {
  test('returns -1 with fewer than two user turns', () => {
    const events = [userEvent('only one'), assistantEvent('reply')];
    expect(findCutEventIndex(events, 10, false)).toBe(-1);
  });

  test('cuts on a user-message boundary leaving the recent tail', () => {
    const events = [
      userEvent(`turn 1 ${'x'.repeat(400)}`),
      assistantEvent(`a1 ${'y'.repeat(400)}`),
      userEvent(`turn 2 ${'z'.repeat(400)}`),
      assistantEvent(`a2 ${'w'.repeat(400)}`),
    ];
    // keepRecent small enough that only the last turn is kept.
    const cut = findCutEventIndex(events, 50, false);
    expect(cut).toBe(2);
    expect(events[cut]?.type).toBe('user_message');
  });

  test('force compacts a small two-turn conversation at the final turn', () => {
    const events = [
      userEvent('hi'),
      assistantEvent('hello'),
      userEvent('again'),
      assistantEvent('yes'),
    ];
    expect(findCutEventIndex(events, 99999, false)).toBe(-1);
    expect(findCutEventIndex(events, 99999, true)).toBe(2);
  });
});

describe('compactSession', () => {
  test('rewrites session to [compaction marker] + kept tail', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-compact-'));
    const sessionsDir = join(workspace, 'sessions');
    const sid = 's1';
    await appendSessionEvent(
      sessionsDir,
      sid,
      userEvent(`first ${'a'.repeat(400)}`),
    );
    await appendSessionEvent(
      sessionsDir,
      sid,
      assistantEvent(`r1 ${'b'.repeat(400)}`),
    );
    await appendSessionEvent(sessionsDir, sid, userEvent('second recent turn'));
    await appendSessionEvent(sessionsDir, sid, assistantEvent('r2 recent'));

    const outcome = await compactSession({
      sessionsDir,
      sessionId: sid,
      modelClient: fixedSummaryClient('## Goal\nDo the thing'),
      model: 'stub',
      keepRecentTokens: 5,
      force: false,
      buildMessages: restoreMessages,
    });

    expect(outcome.compacted).toBe(true);
    if (!outcome.compacted) return;
    expect(outcome.messagesSummarized).toBeGreaterThan(0);

    const events = await readSessionEvents(sessionsDir, sid);
    expect(events[0]?.type).toBe('compaction');
    // The recent turn survives untouched after the marker.
    expect(events.some((e) => e.type === 'user_message')).toBe(true);

    const messages = restoreMessages(events);
    expect(messages[0]?.role).toBe('user');
    expect((messages[0] as { content: string }).content).toContain(
      'compacted to a checkpoint',
    );
    expect((messages[0] as { content: string }).content).toContain(
      'Do the thing',
    );
    // The kept tail is still present after the summary.
    expect(
      messages.some(
        (m) => m.role === 'user' && m.content.includes('second recent turn'),
      ),
    ).toBe(true);
  });

  test('declines when there is nothing to summarize', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-compact-'));
    const sessionsDir = join(workspace, 'sessions');
    await appendSessionEvent(sessionsDir, 's2', userEvent('only turn'));
    const outcome = await compactSession({
      sessionsDir,
      sessionId: 's2',
      modelClient: fixedSummaryClient('x'),
      model: 'stub',
      keepRecentTokens: 5,
      force: true,
      buildMessages: restoreMessages,
    });
    expect(outcome.compacted).toBe(false);
  });
});
