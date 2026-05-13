import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type {
  SerializedMessage,
  SessionEvent,
  SessionSummary,
  TodoItem,
} from '@/types';

function sessionPath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.jsonl`);
}

export function createSessionId(now = new Date()): string {
  return now.toISOString().replaceAll(':', '-');
}

export async function appendSessionEvent(
  sessionsDir: string,
  sessionId: string,
  event: SessionEvent,
): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  const path = sessionPath(sessionsDir, sessionId);
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function appendSessionMeta(
  sessionsDir: string,
  sessionId: string,
  name: string,
  source: 'auto' | 'manual',
): Promise<void> {
  await appendSessionEvent(sessionsDir, sessionId, {
    type: 'session_meta',
    timestamp: new Date().toISOString(),
    name,
    source,
  });
}

export async function readSessionEvents(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionEvent[]> {
  const path = sessionPath(sessionsDir, sessionId);
  const content = await readFile(path, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEvent);
}

export function findSessionName(events: SessionEvent[]): string | undefined {
  let name: string | undefined;
  for (const event of events) {
    if (event.type === 'session_meta') {
      name = event.name;
    }
  }
  return name;
}

export function findLatestPlan(events: SessionEvent[]): TodoItem[] | undefined {
  let todos: TodoItem[] | undefined;
  for (const event of events) {
    if (event.type === 'todo_update') {
      todos = event.todos;
    }
  }
  return todos;
}

export function restoreMessages(events: SessionEvent[]): SerializedMessage[] {
  const messages: SerializedMessage[] = [];
  for (const event of events) {
    if (event.type === 'user_message' || event.type === 'assistant_message') {
      messages.push(event.message);
    }
    if (event.type === 'tool_result') {
      const last = messages.at(-1);
      if (last?.role === 'tool') {
        last.results.push(event.result);
      } else {
        messages.push({
          role: 'tool',
          results: [event.result],
        });
      }
    }
  }
  return messages;
}

export async function listSessions(
  sessionsDir: string,
): Promise<SessionSummary[]> {
  await mkdir(sessionsDir, { recursive: true });
  const entries = await readdir(sessionsDir, { withFileTypes: true });

  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const id = basename(entry.name, '.jsonl');
    const events = await readSessionEvents(sessionsDir, id);
    summaries.push({
      id,
      path: sessionPath(sessionsDir, id),
      updatedAt: events.at(-1)?.timestamp ?? '',
      eventCount: events.length,
      name: findSessionName(events),
    });
  }

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
