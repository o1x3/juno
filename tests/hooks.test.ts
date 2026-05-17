import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTurn } from '@/core/agent-loop';
import { createHookRunner, type HookSpawn, loadHooks } from '@/core/hooks';
import { createBuiltinTools } from '@/core/tools';
import type { ModelClient } from '@/types';

import { makeConfig } from './_fixtures';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  delete process.env.JUNO_DISABLE_HOOKS;
});

const okSpawn: HookSpawn = async () => ({ code: 0, stdout: '', stderr: '' });

describe('loadHooks', () => {
  test('merges global config hooks with project .juno/hooks.json', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-hooks-'));
    const configFile = join(workspace, 'config.json');
    await writeFile(
      configFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'global.sh' }] }],
        },
      }),
      'utf8',
    );
    await mkdir(join(workspace, '.juno'), { recursive: true });
    await writeFile(
      join(workspace, '.juno', 'hooks.json'),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: 'command', command: 'project.sh' }] }],
      }),
      'utf8',
    );

    const hooks = loadHooks({ configFile, cwd: workspace });
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe('global.sh');
    expect(hooks.PreToolUse?.[1]?.hooks[0]?.command).toBe('project.sh');
  });

  test('JUNO_DISABLE_HOOKS short-circuits to nothing', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-hooks-'));
    const configFile = join(workspace, 'config.json');
    await writeFile(
      configFile,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
      'utf8',
    );
    process.env.JUNO_DISABLE_HOOKS = '1';
    expect(loadHooks({ configFile, cwd: workspace })).toEqual({});
  });
});

describe('createHookRunner', () => {
  test('exit 2 blocks with stderr as the reason', async () => {
    const runner = createHookRunner({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'deny.sh' }] }],
      },
      sessionId: 's1',
      cwd: '/tmp',
      spawn: async () => ({ code: 2, stdout: '', stderr: 'not allowed' }),
    });
    const d = await runner.preToolUse('Bash', { command: 'rm -rf /' });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('not allowed');
  });

  test('JSON permissionDecision deny blocks', async () => {
    const runner = createHookRunner({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'gate.sh' }] }],
      },
      sessionId: 's1',
      cwd: '/tmp',
      spawn: async () => ({
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'policy',
          },
        }),
        stderr: '',
      }),
    });
    const d = await runner.preToolUse('Write', { filePath: 'a' });
    expect(d.block).toBe(true);
    expect(d.reason).toBe('policy');
  });

  test('matcher regex filters by tool name', async () => {
    let called = '';
    const spawn: HookSpawn = async (command) => {
      called = command;
      return { code: 0, stdout: '', stderr: '' };
    };
    const runner = createHookRunner({
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'w.sh' }] },
        ],
      },
      sessionId: 's1',
      cwd: '/tmp',
      spawn,
    });
    await runner.preToolUse('Read', { filePath: 'a' });
    expect(called).toBe('');
    await runner.preToolUse('Write', { filePath: 'a' });
    expect(called).toBe('w.sh');
  });

  test('UserPromptSubmit plain stdout becomes additional context', async () => {
    const runner = createHookRunner({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'ctx.sh' }] }],
      },
      sessionId: 's1',
      cwd: '/tmp',
      spawn: async () => ({
        code: 0,
        stdout: 'remember: be terse',
        stderr: '',
      }),
    });
    const d = await runner.userPromptSubmit('hello');
    expect(d.block).toBe(false);
    expect(d.additionalContext).toBe('remember: be terse');
  });

  test('no hooks → inactive no-op', async () => {
    const runner = createHookRunner({
      hooks: {},
      sessionId: 's1',
      cwd: '/tmp',
      spawn: okSpawn,
    });
    expect(runner.active).toBe(false);
    expect((await runner.stop()).block).toBe(false);
  });
});

describe('hooks in the agent loop', () => {
  test('PreToolUse block prevents the tool from executing', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-hooks-loop-'));
    const config = makeConfig(workspace);

    let calls = 0;
    const modelClient: ModelClient = {
      async runStep() {
        calls += 1;
        if (calls === 1) {
          return {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 'c1',
                toolName: 'Write',
                input: { filePath: 'blocked.txt', content: 'nope' },
              },
            ],
          };
        }
        return { text: 'understood', finishReason: 'stop', toolCalls: [] };
      },
    };

    const runner = createHookRunner({
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: 'block' }] },
        ],
      },
      sessionId: 's1',
      cwd: workspace,
      spawn: async () => ({
        code: 2,
        stdout: '',
        stderr: 'writes are frozen',
      }),
    });

    const result = await runAgentTurn({
      config,
      sessionId: 's1',
      model: 'fake-model',
      systemPrompt: 'sys',
      userInput: 'write a file',
      messages: [],
      tools: createBuiltinTools({
        cwd: workspace,
        outputLimit: 1000,
        readLineLimit: 50,
        bashTimeoutMs: 1000,
        sessionsDir: join(workspace, 'sessions'),
        sessionId: 's1',
      }),
      modelClient,
      hooks: runner,
    });

    expect(existsSync(join(workspace, 'blocked.txt'))).toBe(false);
    expect(result.toolResults[0]?.isError).toBe(true);
    expect(String(result.toolResults[0]?.output)).toContain(
      'writes are frozen',
    );
    expect(result.assistantText).toBe('understood');
  });

  test('UserPromptSubmit block ends the turn without calling the model', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-hooks-loop-'));
    const config = makeConfig(workspace);
    let calls = 0;
    const modelClient: ModelClient = {
      async runStep() {
        calls += 1;
        return { text: 'should not run', finishReason: 'stop', toolCalls: [] };
      },
    };
    const runner = createHookRunner({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'gate' }] }],
      },
      sessionId: 's1',
      cwd: workspace,
      spawn: async () => ({ code: 2, stdout: '', stderr: 'prompt rejected' }),
    });

    const result = await runAgentTurn({
      config,
      sessionId: 's1',
      model: 'fake-model',
      systemPrompt: 'sys',
      userInput: 'do something',
      messages: [],
      tools: [],
      modelClient,
      hooks: runner,
    });

    expect(calls).toBe(0);
    expect(result.assistantText).toBe('prompt rejected');
  });
});
