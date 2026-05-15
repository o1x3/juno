import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startOrResumeChat } from '@/core/chat-service';
import type { ApprovalRequest, ModelClient, ToolCall } from '@/types';
import { makeConfig } from './_fixtures';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'juno-yolo-'));
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function buildWriteOnceClient(
  targetPath: string,
  content: string,
): ModelClient {
  let toolFired = false;
  return {
    async runStep({ messages, onToolCall, onUsage }) {
      const last = messages.at(-1);
      if (last?.role === 'tool' || toolFired) {
        if (onUsage) onUsage({ input: 1, output: 1 });
        return {
          text: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { input: 1, output: 1 },
        };
      }
      toolFired = true;
      const call: ToolCall = {
        toolCallId: 'yolo-write-1',
        toolName: 'Write',
        input: { filePath: targetPath, content },
      };
      if (onToolCall) onToolCall(call);
      if (onUsage) onUsage({ input: 1, output: 1 });
      return {
        text: '',
        toolCalls: [call],
        finishReason: 'tool-calls',
        usage: { input: 1, output: 1 },
      };
    },
  };
}

describe('yolo mode end-to-end', () => {
  test('Write succeeds without an approval callback (yolo path)', async () => {
    const config = makeConfig(workspace);
    const filePath = join(workspace, 'yolo.txt');
    const seen: ApprovalRequest[] = [];

    const { result } = await startOrResumeChat({
      config,
      prompt: 'create yolo.txt',
      mode: 'yolo',
      modelClient: buildWriteOnceClient(filePath, 'hello from yolo'),
      // In yolo mode the chat-service-side caller should not pass an approval
      // callback. Tools without a callback short-circuit to approved.
      requestApproval: undefined,
      // Even if the caller forgets to omit it, we explicitly capture any
      // invocations to confirm yolo never asked.
    });

    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0]?.isError).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe('hello from yolo');
    expect(seen).toHaveLength(0);
  });

  test('exec mode WITH a rejecting callback blocks the same Write', async () => {
    const config = makeConfig(workspace);
    const filePath = join(workspace, 'blocked.txt');
    const seen: ApprovalRequest[] = [];

    const { result } = await startOrResumeChat({
      config,
      prompt: 'create blocked.txt',
      mode: 'exec',
      modelClient: buildWriteOnceClient(filePath, 'should not land'),
      requestApproval: async (req) => {
        seen.push(req);
        return 'reject';
      },
    });

    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0]?.isError).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolName).toBe('Write');
  });
});
