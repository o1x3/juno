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

function toolSpec(name: ToolSpec['name']): ToolSpec {
  return {
    name,
    description: `${name} tool`,
    inputSchema: z.object({}).passthrough(),
    execute: async () => ({ toolCallId: 'unused', toolName: name, output: '' }),
  };
}

function functionCallEvents(
  name: string,
  callId: string,
  argsJson: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', name, call_id: callId, arguments: '' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: argsJson,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        name,
        call_id: callId,
        arguments: argsJson,
      },
    },
    { type: 'response.completed', response: { status: 'completed' } },
  ];
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
      tools: [toolSpec('Bash')],
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

  test('routes function_call for LS when LS is in the tool list', async () => {
    const fakeFetch = (async () =>
      sse(
        functionCallEvents('LS', 'call-ls', '{"path":"."}'),
      )) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
    });

    const calls: string[] = [];
    const result = await client.runStep({
      model: 'gpt-5.4',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'what is in this dir' }],
      tools: [toolSpec('LS')],
      onToolCall: (call) => calls.push(`${call.toolName}:${call.toolCallId}`),
    });

    expect(calls).toEqual(['LS:call-ls']);
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call-ls', toolName: 'LS', input: { path: '.' } },
    ]);
  });

  test('routes function_call for TodoWrite when TodoWrite is in the tool list', async () => {
    const fakeFetch = (async () =>
      sse(
        functionCallEvents(
          'TodoWrite',
          'call-td',
          '{"todos":[{"id":"a","content":"x","status":"pending"}]}',
        ),
      )) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
    });

    const calls: string[] = [];
    const result = await client.runStep({
      model: 'gpt-5.4',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'plan it' }],
      tools: [toolSpec('TodoWrite')],
      onToolCall: (call) => calls.push(`${call.toolName}:${call.toolCallId}`),
    });

    expect(calls).toEqual(['TodoWrite:call-td']);
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]?.toolName).toBe('TodoWrite');
  });

  test('ignores function_call for a tool not in the tool list', async () => {
    const fakeFetch = (async () =>
      sse(
        functionCallEvents('Unknown', 'call-x', '{}'),
      )) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
    });

    const calls: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await client.runStep({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'go' }],
        tools: [toolSpec('LS')],
        onToolCall: (call) => calls.push(call.toolName),
      });
      expect(calls).toEqual([]);
      expect(result.toolCalls).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
