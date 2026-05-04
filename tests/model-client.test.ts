import { describe, expect, test } from 'bun:test';

import { toModelMessages, toToolResultOutput } from '@/core/model-client';

describe('model-client serialization', () => {
  test('wraps structured tool results using typed json output', () => {
    expect(
      toToolResultOutput({
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      }),
    ).toEqual({
      type: 'json',
      value: {
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      },
    });
  });

  test('serializes a continued conversation with tool results into valid tool parts', () => {
    const messages = toModelMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
      {
        role: 'tool',
        results: [
          {
            toolCallId: 'call-1',
            toolName: 'Bash',
            output: {
              stdout: 'file.txt',
              stderr: '',
              exitCode: 0,
            },
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'Bash',
            output: {
              type: 'json',
              value: {
                stdout: 'file.txt',
                stderr: '',
                exitCode: 0,
              },
            },
          },
        ],
      },
    ]);
  });
});
