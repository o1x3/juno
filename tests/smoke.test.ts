import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentTurn } from '@/core/agent-loop';
import { loadProjectInstructions } from '@/core/instructions';
import { createBuiltinTools } from '@/core/tools';
import type { AgentConfig, ModelClient } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('smoke path', () => {
  test('applies project instructions, runs tools, and persists a session-friendly turn', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-smoke-'));
    await mkdir(join(workspace, '.git'));
    await writeFile(join(workspace, 'AGENTS.md'), 'Prefer concise changes.');

    const config: AgentConfig = {
      cwd: workspace,
      homeDir: workspace,
      authFile: join(workspace, 'auth.json'),
      sessionsDir: join(workspace, 'sessions'),
      model: 'fake-model',
      apiKey: 'unused',
      maxSteps: 3,
      toolOutputLimit: 1000,
      readLineLimit: 50,
      bashTimeoutMs: 1000,
      codexBackendUrl: 'https://chatgpt.com/backend-api',
    };

    const instructions = await loadProjectInstructions(workspace);
    expect(instructions.mergedContent).toContain('Prefer concise changes.');

    let step = 0;
    const modelClient: ModelClient = {
      async runStep() {
        step += 1;
        return step === 1
          ? {
              text: '',
              finishReason: 'tool-calls',
              toolCalls: [
                {
                  toolCallId: 'call-1',
                  toolName: 'Write',
                  input: { filePath: 'hello.txt', content: 'world' },
                },
              ],
            }
          : {
              text: 'created hello.txt',
              finishReason: 'stop',
              toolCalls: [],
            };
      },
    };

    const result = await runAgentTurn({
      config,
      sessionId: 'smoke',
      systemPrompt: instructions.mergedContent,
      userInput: 'create hello.txt',
      messages: [],
      tools: createBuiltinTools({
        cwd: workspace,
        outputLimit: 1000,
        readLineLimit: 50,
        bashTimeoutMs: 1000,
      }),
      modelClient,
    });

    expect(result.assistantText).toBe('created hello.txt');
    expect(await readFile(join(workspace, 'hello.txt'), 'utf8')).toBe('world');
  });
});
