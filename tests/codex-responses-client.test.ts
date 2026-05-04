import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  buildCodexHeaders,
  buildCodexInput,
  buildCodexTools,
  createCodexResponsesClient,
  resolveCodexUrl,
} from '@/core/codex-responses-client';
import type { ToolSpec } from '@/types';

const FAKE_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' },
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
})();

describe('resolveCodexUrl', () => {
  test('appends /codex/responses when missing', () => {
    expect(resolveCodexUrl('https://chatgpt.com/backend-api')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  test('appends /responses when path ends with /codex', () => {
    expect(resolveCodexUrl('https://example.test/codex')).toBe(
      'https://example.test/codex/responses',
    );
  });

  test('preserves a fully-formed URL', () => {
    expect(resolveCodexUrl('https://example.test/codex/responses')).toBe(
      'https://example.test/codex/responses',
    );
  });
});

describe('buildCodexInput', () => {
  test('maps user, assistant, tool messages to Responses API shape', () => {
    const items = buildCodexInput([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'hello',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        results: [
          {
            toolCallId: 'call-1',
            toolName: 'Bash',
            output: { stdout: 'a\nb', stderr: '', exitCode: 0 },
          },
        ],
      },
    ]);

    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'ls' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({ stdout: 'a\nb', stderr: '', exitCode: 0 }),
      },
    ]);
  });
});

describe('buildCodexTools', () => {
  test('converts Zod ToolSpec into Responses-API function tool', () => {
    const specs: ToolSpec[] = [
      {
        name: 'Read',
        description: 'reads files',
        inputSchema: z.object({
          filePath: z.string(),
          startLine: z.number().int().positive().optional(),
        }),
        execute: async () => ({
          toolCallId: 'x',
          toolName: 'Read',
          output: 'unused',
        }),
      },
    ];
    const tools = buildCodexTools(specs);
    expect(tools[0]?.name).toBe('Read');
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.parameters).toMatchObject({
      type: 'object',
      properties: {
        filePath: { type: 'string' },
      },
      required: ['filePath'],
    });
  });
});

describe('buildCodexHeaders', () => {
  test('sets Authorization, chatgpt-account-id, originator, beta header', () => {
    const headers = buildCodexHeaders({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      sessionId: 'sess-1',
    });
    expect(headers.get('Authorization')).toBe(`Bearer ${FAKE_JWT}`);
    expect(headers.get('chatgpt-account-id')).toBe('acct-1');
    expect(headers.get('OpenAI-Beta')).toBe('responses=experimental');
    expect(headers.get('originator')).toBe('juno');
    expect(headers.get('session_id')).toBe('sess-1');
  });
});

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createCodexResponsesClient runStep', () => {
  test('emits text deltas and finalizes a function call', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), init: init ?? {} };
      return sse([
        { type: 'response.output_text.delta', delta: 'hi ' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            name: 'Bash',
            call_id: 'call-9',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"command":"ls"}',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            name: 'Bash',
            call_id: 'call-9',
            arguments: '{"command":"ls"}',
          },
        },
        { type: 'response.completed', response: { status: 'completed' } },
      ]);
    }) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      sessionId: 'sess-9',
      fetchImpl: fakeFetch,
    });

    let textOut = '';
    const calls: string[] = [];
    const result = await client.runStep({
      model: 'gpt-5.1-codex-mini',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'list files' }],
      tools: [],
      onTextDelta: (delta) => {
        textOut += delta;
      },
      onToolCall: (call) => {
        calls.push(`${call.toolName}:${call.toolCallId}`);
      },
    });

    expect(textOut).toBe('hi ');
    expect(result.text).toBe('hi ');
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]).toMatchObject({
      toolName: 'Bash',
      toolCallId: 'call-9',
      input: { command: 'ls' },
    });
    expect(calls).toEqual(['Bash:call-9']);
    expect(result.finishReason).toBe('completed');

    expect(captured).toBeDefined();
    expect(captured?.url).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
    const sentBody = JSON.parse(String(captured?.init.body)) as {
      model: string;
      store: boolean;
      stream: boolean;
      instructions: string;
    };
    expect(sentBody.model).toBe('gpt-5.1-codex-mini');
    expect(sentBody.store).toBe(false);
    expect(sentBody.stream).toBe(true);
    expect(sentBody.instructions).toBe('system');
  });

  test('throws a friendly error for usage_limit_reached HTTP 429', async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 'usage_limit_reached',
            message: 'limit',
            plan_type: 'PLUS',
          },
        }),
        { status: 429 },
      );
    }) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
    });

    await expect(
      client.runStep({
        model: 'gpt-5.1-codex-mini',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      }),
    ).rejects.toThrow(/usage limit reached/i);
  });
});
