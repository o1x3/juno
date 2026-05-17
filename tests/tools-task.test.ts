import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILTIN_AGENTS } from '@/core/agents';
import { startOrResumeChat } from '@/core/chat-service';
import { createBuiltinTools } from '@/core/tools';
import type { ModelClient, ToolCall, ToolContext, ToolSpec } from '@/types';
import { makeConfig } from './_fixtures';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function ctx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 2000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

function taskTool(deps: Parameters<typeof createBuiltinTools>[1]): ToolSpec {
  const tool = createBuiltinTools(ctx(), deps).find((t) => t.name === 'Task');
  if (!tool) throw new Error('Task tool missing');
  return tool;
}

describe('Task tool (unit, injected spawnSubAgent)', () => {
  test('not wired → friendly error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-task-nw-'));
    const tool = taskTool({});
    const r = await tool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'general' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('not wired');
  });

  test('unknown agent lists valid types', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-task-unknown-'));
    const tool = taskTool({
      agents: BUILTIN_AGENTS,
      spawnSubAgent: async () => ({ taskId: 'x', text: '', toolCalls: 0 }),
    });
    const r = await tool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'nope' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('not a valid agent type');
    expect(String(r.output)).toContain('general');
    expect(String(r.output)).toContain('explore');
  });

  test('resolves agent + threads taskId, returns result', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-task-ok-'));
    let captured: { agent: string; taskId?: string } | undefined;
    const tool = taskTool({
      agents: BUILTIN_AGENTS,
      spawnSubAgent: async (req) => {
        captured = { agent: req.agent.name, taskId: req.taskId };
        return { taskId: 'sess-42', text: 'all done', toolCalls: 3 };
      },
    });
    const r = await tool.execute(
      {
        description: 'do thing',
        prompt: 'go',
        subagent_type: 'general',
        task_id: 'resume-me',
      },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(captured).toEqual({ agent: 'general', taskId: 'resume-me' });
    const out = r.output as {
      task_id: string;
      agent: string;
      result: string;
      tool_calls: number;
    };
    expect(out.task_id).toBe('sess-42');
    expect(out.agent).toBe('general');
    expect(out.result).toBe('all done');
    expect(out.tool_calls).toBe(3);
  });

  test('empty prompt rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-task-empty-'));
    const tool = taskTool({
      agents: BUILTIN_AGENTS,
      spawnSubAgent: async () => ({ taskId: 'x', text: '', toolCalls: 0 }),
    });
    const r = await tool.execute(
      { description: 'd', prompt: '  ', subagent_type: 'general' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('non-empty');
  });
});

// End-to-end through chat-service: the parent emits a Task call; the child
// loop runs with its own tools and MUST NOT have Task (recursion safety).
describe('Task end-to-end via chat-service', () => {
  test('child runs, can write, has no Task tool, summary propagates', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-task-e2e-'));
    const config = makeConfig(workspace);
    const childFile = join(workspace, 'from-child.txt');

    let childToolNames: string[] = [];
    const client: ModelClient = {
      async runStep({ systemPrompt, messages, tools, onToolCall, onUsage }) {
        const usage = { input: 1, output: 1 };
        const last = messages.at(-1);
        const isChild = systemPrompt.includes('general-purpose sub-agent');

        if (isChild) {
          childToolNames = tools.map((t) => String(t.name));
          if (last?.role === 'tool') {
            if (onUsage) onUsage(usage);
            return {
              text: 'child summary: wrote the file',
              toolCalls: [],
              finishReason: 'stop',
              usage,
            };
          }
          const call: ToolCall = {
            toolCallId: 'child-write-1',
            toolName: 'Write',
            input: { filePath: childFile, content: 'hi from child' },
          };
          if (onToolCall) onToolCall(call);
          if (onUsage) onUsage(usage);
          return {
            text: '',
            toolCalls: [call],
            finishReason: 'tool-calls',
            usage,
          };
        }

        // Parent.
        if (last?.role === 'tool') {
          if (onUsage) onUsage(usage);
          return {
            text: 'parent relayed the summary',
            toolCalls: [],
            finishReason: 'stop',
            usage,
          };
        }
        const call: ToolCall = {
          toolCallId: 'parent-task-1',
          toolName: 'Task',
          input: {
            description: 'write a file',
            prompt: 'create from-child.txt with hi from child',
            subagent_type: 'general',
          },
        };
        if (onToolCall) onToolCall(call);
        if (onUsage) onUsage(usage);
        return {
          text: '',
          toolCalls: [call],
          finishReason: 'tool-calls',
          usage,
        };
      },
    };

    const { result } = await startOrResumeChat({
      config,
      prompt: 'delegate writing a file to a sub-agent',
      mode: 'exec',
      modelClient: client,
    });

    // Child actually wrote the file through its own approval-free loop.
    expect(existsSync(childFile)).toBe(true);
    expect(await readFile(childFile, 'utf8')).toBe('hi from child');

    // Recursion safety: the sub-agent's tool set excluded Task.
    expect(childToolNames.length).toBeGreaterThan(0);
    expect(childToolNames).not.toContain('Task');
    // general also drops TodoWrite.
    expect(childToolNames).not.toContain('TodoWrite');
    expect(childToolNames).toContain('Write');

    // Parent saw the Task tool result with the child's summary.
    const taskResult = result.toolResults.find((tr) => tr.toolName === 'Task');
    expect(taskResult?.isError).toBeUndefined();
    const out = taskResult?.output as { agent: string; result: string };
    expect(out.agent).toBe('general');
    expect(out.result).toBe('child summary: wrote the file');
    expect(result.assistantText).toBe('parent relayed the summary');
  });
});
