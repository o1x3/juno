// `/undo` — revert the workspace and conversation to the snapshot taken at the
// start of the most recent turn. Each turn appends a `snapshot` event right
// after its `user_message`, so undoing means: restore that snapshot tree and
// truncate the JSONL back to just before that turn's user message. Repeated
// undo walks back turn by turn.

import { join } from 'node:path';

import { atomicWrite } from '@/core/fs';
import { readSessionEvents } from '@/core/session-store';
import { SnapshotStore } from '@/core/snapshot';
import type { SessionEvent } from '@/types';

export type UndoResult =
  | {
      undone: true;
      hash: string;
      removedEvents: number;
      remainingEvents: SessionEvent[];
      diff: string;
    }
  | { undone: false; reason: string };

export async function undoLastTurn(opts: {
  cwd: string;
  homeDir: string;
  sessionsDir: string;
  sessionId: string;
  store?: SnapshotStore;
}): Promise<UndoResult> {
  let events: SessionEvent[];
  try {
    events = await readSessionEvents(opts.sessionsDir, opts.sessionId);
  } catch {
    return { undone: false, reason: 'no session to undo' };
  }

  let snapIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'snapshot') {
      snapIdx = i;
      break;
    }
  }
  if (snapIdx === -1) {
    return {
      undone: false,
      reason: 'no snapshot found — nothing to undo in this session',
    };
  }

  const snap = events[snapIdx] as Extract<SessionEvent, { type: 'snapshot' }>;

  // The user_message that opened this turn sits just before its snapshot.
  let cutIdx = snapIdx;
  for (let i = snapIdx - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'user_message') {
      cutIdx = i;
      break;
    }
  }

  const store =
    opts.store ?? new SnapshotStore({ cwd: opts.cwd, homeDir: opts.homeDir });
  const diff = await store.diff(snap.hash);
  const restored = await store.restore(snap.hash);
  if (!restored.ok) {
    return {
      undone: false,
      reason: `filesystem restore failed: ${restored.error ?? 'unknown error'}`,
    };
  }

  const remaining = events.slice(0, cutIdx);
  const path = join(opts.sessionsDir, `${opts.sessionId}.jsonl`);
  const body = remaining.map((e) => JSON.stringify(e)).join('\n');
  await atomicWrite(path, body.length > 0 ? `${body}\n` : '');

  return {
    undone: true,
    hash: snap.hash,
    removedEvents: events.length - remaining.length,
    remainingEvents: remaining,
    diff,
  };
}
