import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { buildCodexTools } from '@/core/codex-responses-client';
import type { ToolSpec } from '@/types';

describe('buildCodexTools', () => {
  test('passes through ToolSpec.parameters verbatim for MCP-style tools', () => {
    const params = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    };
    const spec: ToolSpec = {
      name: 'exa_web_search',
      description: '[mcp:exa] search',
      inputSchema: z.unknown(),
      parameters: params,
      execute: async () => ({
        toolCallId: '1',
        toolName: 'exa_web_search',
        output: null,
      }),
    };
    const tools = buildCodexTools([spec]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('exa_web_search');
    expect(tools[0]?.parameters).toEqual(params);
  });

  test('still converts a plain zod schema when parameters is absent', () => {
    const spec: ToolSpec = {
      name: 'Read',
      description: 'read',
      inputSchema: z.object({ filePath: z.string() }),
      execute: async () => ({
        toolCallId: '1',
        toolName: 'Read',
        output: null,
      }),
    };
    const [tool] = buildCodexTools([spec]);
    const params = tool?.parameters as Record<string, unknown>;
    expect(params?.type).toBe('object');
    expect(
      (params?.properties as Record<string, unknown>).filePath,
    ).toBeTruthy();
  });
});
