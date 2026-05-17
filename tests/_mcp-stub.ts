#!/usr/bin/env bun
// Tiny stdio MCP server for tests.
// Implements: initialize, tools/list, tools/call (with two demo tools).
// Reads framed JSON-RPC over stdin (one message per line), writes responses
// to stdout the same way. Matches the MCP stdio transport's line-delimited
// framing used by @modelcontextprotocol/sdk's StdioClientTransport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'juno-mcp-stub', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the provided text back to the caller.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'add',
      description: 'Return the sum of two integers.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  if (name === 'echo') {
    const text = typeof args.text === 'string' ? args.text : '';
    return {
      content: [{ type: 'text', text }],
    };
  }
  if (name === 'add') {
    const a = typeof args.a === 'number' ? args.a : 0;
    const b = typeof args.b === 'number' ? args.b : 0;
    return {
      content: [{ type: 'text', text: String(a + b) }],
    };
  }
  if (name === 'boom') {
    throw new Error('synthetic-failure');
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
