// Context compaction for long sessions.
//
// When a conversation outgrows the model's context window we summarize the
// older turns into a single checkpoint and keep only the recent tail. Adapted
// from pi-mono's compaction (chars/4 estimate, turn-boundary cut points,
// structured-checkpoint summary prompt) but operating on Juno's append-only
// JSONL SessionEvents instead of pi's entry tree.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readSessionEvents } from '@/core/session-store';
import type { ModelClient, SerializedMessage, SessionEvent } from '@/types';

export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context-compression engine. You produce a faithful, structured checkpoint of a coding session so another agent can continue the work with no loss of essential state. Output only the checkpoint — no preamble, no sign-off.';

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint another agent will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints/preferences stated by the user, or "(none)"]

## Progress
### Done
- [Completed changes — keep exact file paths and identifiers]
### In Progress
- [Current work]
### Blocked
- [Blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Data, paths, errors, snippets needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export function estimateMessageTokens(message: SerializedMessage): number {
  let chars = 0;
  if (message.role === 'user') {
    chars = message.content.length;
  } else if (message.role === 'assistant') {
    chars = message.content.length;
    for (const call of message.toolCalls ?? []) {
      chars += call.toolName.length + JSON.stringify(call.input).length;
    }
  } else {
    for (const r of message.results) {
      chars +=
        typeof r.output === 'string'
          ? r.output.length
          : JSON.stringify(r.output).length;
    }
  }
  return Math.ceil(chars / 4);
}

export function estimateConversationTokens(
  messages: SerializedMessage[],
): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

function eventTokens(event: SessionEvent): number {
  if (event.type === 'user_message') {
    return estimateMessageTokens(event.message);
  }
  if (event.type === 'assistant_message') {
    return estimateMessageTokens(event.message);
  }
  if (event.type === 'tool_result') {
    return estimateMessageTokens({ role: 'tool', results: [event.result] });
  }
  return 0;
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  return contextTokens > contextWindow - reserveTokens;
}

/**
 * Find the event index of the first event to KEEP. The cut always lands on a
 * `user_message` so a turn (assistant ↔ tool_result chain) is never split.
 * Returns -1 when there is nothing worth compacting (no earlier turn to fold
 * into a summary).
 */
export function findCutEventIndex(
  events: SessionEvent[],
  keepRecentTokens: number,
  force: boolean,
): number {
  const userIdxs: number[] = [];
  for (let i = 0; i < events.length; i += 1) {
    if (events[i]?.type === 'user_message') userIdxs.push(i);
  }
  if (userIdxs.length < 2) return -1;

  // Walk user-message boundaries newest→oldest; cut at the oldest boundary that
  // still leaves >= keepRecentTokens in the kept tail.
  for (let k = userIdxs.length - 1; k >= 1; k -= 1) {
    const idx = userIdxs[k] as number;
    let tail = 0;
    for (let j = idx; j < events.length; j += 1) {
      tail += eventTokens(events[j] as SessionEvent);
    }
    if (tail >= keepRecentTokens) {
      return idx;
    }
  }
  // Whole conversation is under the keep budget. Only compact under force, and
  // then fold everything before the final turn into the summary.
  return force ? (userIdxs[userIdxs.length - 1] as number) : -1;
}

function serializeForSummary(messages: SerializedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`USER: ${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) lines.push(`ASSISTANT: ${m.content}`);
      for (const c of m.toolCalls ?? []) {
        lines.push(`TOOL_CALL ${c.toolName}(${JSON.stringify(c.input)})`);
      }
    } else {
      for (const r of m.results) {
        const out =
          typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
        lines.push(
          `TOOL_RESULT ${r.toolName}${r.isError ? ' [error]' : ''}: ${out.slice(0, 4000)}`,
        );
      }
    }
  }
  return lines.join('\n');
}

export async function summarizeMessages(
  client: ModelClient,
  model: string,
  messages: SerializedMessage[],
): Promise<string> {
  const conversation = serializeForSummary(messages);
  const step = await client.runStep({
    model,
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `<conversation>\n${conversation}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
      },
    ],
    tools: [],
  });
  return step.text.trim();
}

export type CompactionOutcome =
  | {
      compacted: true;
      summary: string;
      tokensBefore: number;
      messagesSummarized: number;
    }
  | { compacted: false; reason: string };

/**
 * Rewrite the session JSONL as `[compaction marker] + kept tail`. The marker
 * carries the summary; `restoreMessages` seeds it as a single user message and
 * replays the tail, so the next turn runs on a small context.
 */
export async function compactSession(opts: {
  sessionsDir: string;
  sessionId: string;
  modelClient: ModelClient;
  model: string;
  keepRecentTokens: number;
  force: boolean;
  buildMessages: (events: SessionEvent[]) => SerializedMessage[];
}): Promise<CompactionOutcome> {
  let events: SessionEvent[];
  try {
    events = await readSessionEvents(opts.sessionsDir, opts.sessionId);
  } catch {
    return { compacted: false, reason: 'no session to compact' };
  }

  const cut = findCutEventIndex(events, opts.keepRecentTokens, opts.force);
  if (cut <= 0) {
    return {
      compacted: false,
      reason: 'not enough history to compact (need at least two turns)',
    };
  }

  const head = events.slice(0, cut);
  const tail = events.slice(cut);
  const headMessages = opts.buildMessages(head);
  if (headMessages.length === 0) {
    return { compacted: false, reason: 'nothing to summarize' };
  }
  const tokensBefore = estimateConversationTokens(opts.buildMessages(events));

  let summary: string;
  try {
    summary = await summarizeMessages(
      opts.modelClient,
      opts.model,
      headMessages,
    );
  } catch (error) {
    return {
      compacted: false,
      reason: `summarization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!summary) {
    return { compacted: false, reason: 'summarizer returned no content' };
  }

  const marker: SessionEvent = {
    type: 'compaction',
    timestamp: new Date().toISOString(),
    summary,
    tokensBefore,
    messagesSummarized: headMessages.length,
  };
  const rewritten = [marker, ...tail];
  const path = join(opts.sessionsDir, `${opts.sessionId}.jsonl`);
  const body = rewritten.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(path, body.length > 0 ? `${body}\n` : '', 'utf8');

  return {
    compacted: true,
    summary,
    tokensBefore,
    messagesSummarized: headMessages.length,
  };
}
