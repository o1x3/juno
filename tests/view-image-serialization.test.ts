import { describe, expect, test } from 'bun:test';

import { buildCodexInput } from '@/core/codex-responses-client';
import { toModelMessages } from '@/core/model-client';
import type { SerializedMessage } from '@/types';

const dataUrl = 'data:image/png;base64,QUJD';

const messages: SerializedMessage[] = [
  { role: 'user', content: 'look at this' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { toolCallId: 'vi-1', toolName: 'view_image', input: { path: 'a.png' } },
    ],
  },
  {
    role: 'tool',
    results: [
      {
        toolCallId: 'vi-1',
        toolName: 'view_image',
        output: { path: 'a.png', image_url: dataUrl, detail: null },
        media: {
          kind: 'image',
          dataUrl,
          mediaType: 'image/png',
          detail: null,
        },
      },
    ],
  },
];

describe('view_image serialization → AI SDK path', () => {
  test('image media becomes a content/media tool-result part', () => {
    const mm = toModelMessages(messages);
    const toolMsg = mm.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = (toolMsg as { content: unknown[] }).content[0] as {
      output: { type: string; value: unknown[] };
    };
    expect(content.output.type).toBe('content');
    expect(content.output.value).toEqual([
      { type: 'media', data: 'QUJD', mediaType: 'image/png' },
    ]);
  });

  test('non-media results still serialize as text/json', () => {
    const mm = toModelMessages([
      {
        role: 'tool',
        results: [{ toolCallId: 'x', toolName: 'Read', output: 'plain text' }],
      },
    ]);
    const part = (mm[0] as { content: { output: unknown }[] }).content[0];
    expect(part.output).toEqual({ type: 'text', value: 'plain text' });
  });
});

describe('view_image serialization → Codex Responses path', () => {
  test('image media becomes a function_call_output with input_image', () => {
    const input = buildCodexInput(messages);
    const out = input.find((i) => i.type === 'function_call_output') as {
      type: 'function_call_output';
      call_id: string;
      output: Array<{ type: string; image_url: string; detail: unknown }>;
    };
    expect(out.call_id).toBe('vi-1');
    expect(Array.isArray(out.output)).toBe(true);
    expect(out.output).toEqual([
      { type: 'input_image', image_url: dataUrl, detail: null },
    ]);
  });

  test('original detail is threaded through to the Codex content item', () => {
    const input = buildCodexInput([
      {
        role: 'tool',
        results: [
          {
            toolCallId: 'vi-2',
            toolName: 'view_image',
            output: {},
            media: {
              kind: 'image',
              dataUrl,
              mediaType: 'image/png',
              detail: 'original',
            },
          },
        ],
      },
    ]);
    const out = input[0] as {
      output: Array<{ detail: unknown }>;
    };
    expect(out.output[0]?.detail).toBe('original');
  });

  test('ordinary results still serialize as a string', () => {
    const input = buildCodexInput([
      {
        role: 'tool',
        results: [
          {
            toolCallId: 'r1',
            toolName: 'Read',
            output: { content: 'hi' },
          },
        ],
      },
    ]);
    const out = input[0] as { output: unknown };
    expect(typeof out.output).toBe('string');
    expect(out.output).toBe(JSON.stringify({ content: 'hi' }));
  });
});
