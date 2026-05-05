import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTurn } from '@/core/agent-loop';
import { createBuiltinTools } from '@/core/tools';
import type { ModelClient } from '@/types';

import { makeConfig } from './_fixtures';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('agent loop', () => {
  test('continues after tool calls and exits on plain assistant text', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-loop-'));
    const config = makeConfig(workspace);

    let callCount = 0;
    const modelClient: ModelClient = {
      async runStep() {
        callCount += 1;
        if (callCount === 1) {
          return {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 'call-1',
                toolName: 'Write',
                input: { filePath: 'note.txt', content: 'hello' },
              },
            ],
          };
        }

        return {
          text: 'done',
          finishReason: 'stop',
          toolCalls: [],
        };
      },
    };

    const result = await runAgentTurn({
      config,
      sessionId: 's1',
      model: 'fake-model',
      systemPrompt: 'test',
      userInput: 'write a file',
      messages: [],
      tools: createBuiltinTools({
        cwd: workspace,
        outputLimit: 1000,
        readLineLimit: 50,
        bashTimeoutMs: 1000,
      }),
      modelClient,
    });

    expect(result.assistantText).toBe('done');
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('hello');
  });
});
