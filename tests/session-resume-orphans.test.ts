import { describe, expect, test } from 'bun:test';

import { restoreMessages } from '@/core/session-store';
import type { SessionEvent } from '@/types';

function ts(idx: number): string {
  return new Date(1700000000000 + idx * 1000).toISOString();
}

describe('restoreMessages — orphan tool_call injection', () => {
  test('no orphans: round-trip unchanged', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_message',
        timestamp: ts(0),
        message: { role: 'user', content: 'hi' },
      },
      {
        type: 'assistant_message',
        timestamp: ts(1),
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { toolCallId: 'a', toolName: 'Read', input: { filePath: 'x.ts' } },
          ],
        },
      },
      {
        type: 'tool_call',
        timestamp: ts(2),
        call: {
          toolCallId: 'a',
          toolName: 'Read',
          input: { filePath: 'x.ts' },
        },
      },
      {
        type: 'tool_result',
        timestamp: ts(3),
        result: { toolCallId: 'a', toolName: 'Read', output: { content: '' } },
      },
      {
        type: 'assistant_message',
        timestamp: ts(4),
        message: { role: 'assistant', content: 'done' },
      },
    ];

    const restored = restoreMessages(events);
    expect(restored).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { toolCallId: 'a', toolName: 'Read', input: { filePath: 'x.ts' } },
        ],
      },
      {
        role: 'tool',
        results: [
          { toolCallId: 'a', toolName: 'Read', output: { content: '' } },
        ],
      },
      { role: 'assistant', content: 'done' },
    ]);
  });

  test('orphan at end-of-log gets a synthetic interrupted tool_result', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_message',
        timestamp: ts(0),
        message: { role: 'user', content: 'ask me something' },
      },
      {
        type: 'assistant_message',
        timestamp: ts(1),
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              toolCallId: 'q1',
              toolName: 'AskUserQuestion',
              input: {
                question: 'pick',
                options: [{ label: 'a' }, { label: 'b' }],
              },
            },
          ],
        },
      },
      {
        type: 'tool_call',
        timestamp: ts(2),
        call: {
          toolCallId: 'q1',
          toolName: 'AskUserQuestion',
          input: {
            question: 'pick',
            options: [{ label: 'a' }, { label: 'b' }],
          },
        },
      },
      // (process killed here — no tool_result for q1)
    ];

    const restored = restoreMessages(events);
    expect(restored).toHaveLength(3);
    const last = restored[2];
    expect(last?.role).toBe('tool');
    if (last?.role !== 'tool') throw new Error('unreachable');
    expect(last.results).toHaveLength(1);
    expect(last.results[0]?.toolCallId).toBe('q1');
    expect(last.results[0]?.toolName).toBe('AskUserQuestion');
    expect(last.results[0]?.isError).toBe(true);
    expect(String(last.results[0]?.output)).toContain('interrupted');
  });

  test('multi-orphan: only the missing tool_result is synthesized', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_message',
        timestamp: ts(0),
        message: { role: 'user', content: 'do two things' },
      },
      {
        type: 'assistant_message',
        timestamp: ts(1),
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              toolCallId: 't1',
              toolName: 'Read',
              input: { filePath: 'a.ts' },
            },
            {
              toolCallId: 't2',
              toolName: 'Bash',
              input: { command: 'echo hi' },
            },
          ],
        },
      },
      {
        type: 'tool_result',
        timestamp: ts(2),
        result: {
          toolCallId: 't1',
          toolName: 'Read',
          output: { content: 'data' },
        },
      },
      // (process killed — t2 never resolved)
    ];

    const restored = restoreMessages(events);
    const last = restored.at(-1);
    expect(last?.role).toBe('tool');
    if (last?.role !== 'tool') throw new Error('unreachable');
    expect(last.results).toHaveLength(2);
    expect(last.results[0]?.toolCallId).toBe('t1');
    expect(last.results[0]?.isError).toBeUndefined();
    expect(last.results[1]?.toolCallId).toBe('t2');
    expect(last.results[1]?.toolName).toBe('Bash');
    expect(last.results[1]?.isError).toBe(true);
  });

  test('orphan from an old turn gets flushed before a later user message', () => {
    const events: SessionEvent[] = [
      {
        type: 'user_message',
        timestamp: ts(0),
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'assistant_message',
        timestamp: ts(1),
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              toolCallId: 'orph',
              toolName: 'Edit',
              input: { filePath: 'x', oldString: 'a', newString: 'b' },
            },
          ],
        },
      },
      // no tool_result for orph — simulating a crash mid-edit
      {
        type: 'user_message',
        timestamp: ts(2),
        message: { role: 'user', content: 'second' },
      },
    ];

    const restored = restoreMessages(events);
    // user, assistant, tool (synthetic), user
    expect(restored).toHaveLength(4);
    expect(restored[0]?.role).toBe('user');
    expect(restored[1]?.role).toBe('assistant');
    expect(restored[2]?.role).toBe('tool');
    expect(restored[3]?.role).toBe('user');
    if (restored[2]?.role !== 'tool') throw new Error('unreachable');
    expect(restored[2].results[0]?.toolCallId).toBe('orph');
    expect(restored[2].results[0]?.isError).toBe(true);
  });
});
