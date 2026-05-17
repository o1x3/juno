import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type {
  ApprovalDecision,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '@/types';

export type McpLocalServerConfig = {
  type: 'local';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
};

export type McpRemoteServerConfig = {
  type: 'remote';
  url: string;
  transport?: 'http' | 'sse';
  headers?: Record<string, string>;
  enabled?: boolean;
};

export type McpServerConfig = McpLocalServerConfig | McpRemoteServerConfig;

export type McpConfigFile = {
  mcpServers?: Record<string, McpServerConfig>;
};

const localServerSchema = z.object({
  type: z.literal('local'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
});

const remoteServerSchema = z.object({
  type: z.literal('remote'),
  url: z.string().min(1),
  transport: z.enum(['http', 'sse']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const serverSchema = z.union([localServerSchema, remoteServerSchema]);
const fileSchema = z.object({
  mcpServers: z.record(z.string(), serverSchema).optional(),
});

export type McpClientEntry = {
  server: string;
  client: Client;
  close: () => Promise<void>;
  toolNames: string[];
};

export type McpRegistry = {
  tools: ToolSpec[];
  clients: McpClientEntry[];
  warnings: string[];
  closeAll(): Promise<void>;
};

export type LoadMcpConfigOptions = {
  cwd: string;
  homeDir: string;
  explicitPath?: string;
};

export async function loadMcpConfig(
  options: LoadMcpConfigOptions,
): Promise<{ servers: Record<string, McpServerConfig>; sources: string[] }> {
  const candidates: string[] = [];
  if (options.explicitPath) {
    candidates.push(options.explicitPath);
  } else {
    candidates.push(join(options.cwd, '.mcp.json'));
    candidates.push(join(options.homeDir, 'mcp.json'));
  }

  const sources: string[] = [];
  // home-dir config first, then cwd config overrides per-key — so iterate in
  // reverse precedence and let the later assignment win.
  const ordered = [...candidates].reverse();
  const merged: Record<string, McpServerConfig> = {};
  for (const path of ordered) {
    if (!existsSync(path)) continue;
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    let parsed: McpConfigFile;
    try {
      parsed = fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Invalid MCP config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    sources.push(path);
    if (parsed.mcpServers) {
      for (const [name, server] of Object.entries(parsed.mcpServers)) {
        merged[name] = server;
      }
    }
  }

  return { servers: merged, sources };
}

export function sanitizeToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${clean(server)}_${clean(tool)}`;
}

type McpToolDeps = {
  /** Test-only direct approval gate. In production, approvals come via ToolContext.requestApproval. */
  approvalGate?: (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason?: string }>;
};

function rejectionReason(decision: ApprovalDecision): string | undefined {
  if (typeof decision === 'string') return undefined;
  return decision.reason;
}

function buildMcpToolSpec(
  server: string,
  client: Client,
  raw: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  },
  deps: McpToolDeps,
): ToolSpec {
  const fullName = sanitizeToolName(server, raw.name);
  const description = raw.description
    ? `[mcp:${server}] ${raw.description}`
    : `[mcp:${server}] ${raw.name}`;
  const parameters =
    raw.inputSchema && typeof raw.inputSchema === 'object'
      ? (raw.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {}, additionalProperties: true };

  return {
    name: fullName,
    description,
    inputSchema: z.unknown(),
    parameters,
    execute: async (
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
      const { toolCallId: _ignored, ...rest } = input;
      const args = rest as Record<string, unknown>;
      try {
        // Two approval paths:
        // 1. test direct gate (`deps.approvalGate`) — used by tests/mcp.test.ts.
        // 2. runtime gate via `ctx.requestApproval` — used by the live agent.
        // yolo mode passes no callback, so MCP calls run unattended.
        if (deps.approvalGate) {
          const gate = await deps.approvalGate(server, raw.name, args);
          if (!gate.approved) {
            const reasonSuffix =
              gate.reason && gate.reason.trim().length > 0
                ? `: ${gate.reason.trim()}`
                : '';
            return {
              toolCallId,
              toolName: fullName,
              output: `user rejected mcp:${server}/${raw.name}${reasonSuffix}`,
              isError: true,
            };
          }
        } else if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolName: fullName,
            preview: {
              kind: 'mcp',
              server,
              tool: raw.name,
              args,
            },
          });
          if (
            decision === 'reject' ||
            (typeof decision !== 'string' && decision.decision === 'reject')
          ) {
            const reason = rejectionReason(decision);
            const reasonSuffix =
              reason && reason.trim().length > 0 ? `: ${reason.trim()}` : '';
            return {
              toolCallId,
              toolName: fullName,
              output: `user rejected mcp:${server}/${raw.name}${reasonSuffix}`,
              isError: true,
            };
          }
        }
        const result = await client.callTool({
          name: raw.name,
          arguments: args,
        });
        const isError = Boolean(result?.isError);
        return {
          toolCallId,
          toolName: fullName,
          output: result,
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          toolCallId,
          toolName: fullName,
          output: `mcp:${server}/${raw.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

export type ConnectMcpServersOptions = {
  servers: Record<string, McpServerConfig>;
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  approvalGate?: McpToolDeps['approvalGate'];
};

async function createTransport(
  config: McpServerConfig,
): Promise<{ transport: unknown; close: () => Promise<void> }> {
  if (config.type === 'local') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      cwd: config.cwd,
    });
    return {
      transport,
      close: async () => {
        await transport.close();
      },
    };
  }
  const url = new URL(config.url);
  const requestInit = config.headers
    ? { headers: config.headers as Record<string, string> }
    : undefined;
  if (config.transport === 'sse') {
    const transport = new SSEClientTransport(url, {
      requestInit,
      eventSourceInit: requestInit
        ? { fetch: (input, init) => fetch(input, { ...init, ...requestInit }) }
        : undefined,
    });
    return {
      transport,
      close: async () => {
        await transport.close();
      },
    };
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit,
  });
  return {
    transport,
    close: async () => {
      await transport.close();
    },
  };
}

export async function connectMcpServers(
  options: ConnectMcpServersOptions,
): Promise<McpRegistry> {
  const tools: ToolSpec[] = [];
  const clients: McpClientEntry[] = [];
  const warnings: string[] = [];

  const entries = Object.entries(options.servers).filter(
    ([, cfg]) => cfg.enabled !== false,
  );

  await Promise.all(
    entries.map(async ([name, cfg]) => {
      let transportEntry:
        | { transport: unknown; close: () => Promise<void> }
        | undefined;
      try {
        transportEntry = await createTransport(cfg);
        const client = new Client(
          {
            name: options.clientName ?? 'juno',
            version: options.clientVersion ?? '0.1.0',
          },
          { capabilities: {} },
        );
        await client.connect(transportEntry.transport as never);
        const listed = await client.listTools(undefined, {
          timeout: options.requestTimeoutMs ?? 10_000,
        });
        const rawTools = Array.isArray(listed.tools) ? listed.tools : [];
        const toolNames: string[] = [];
        for (const raw of rawTools) {
          if (!raw?.name) continue;
          const spec = buildMcpToolSpec(
            name,
            client,
            {
              name: raw.name,
              description: raw.description,
              inputSchema: raw.inputSchema as
                | Record<string, unknown>
                | undefined,
            },
            { approvalGate: options.approvalGate },
          );
          tools.push(spec);
          toolNames.push(spec.name);
        }
        clients.push({
          server: name,
          client,
          close: transportEntry.close,
          toolNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`mcp:${name} failed to connect: ${message}`);
        if (transportEntry) {
          try {
            await transportEntry.close();
          } catch {
            // ignore close failure on already-failed transport
          }
        }
      }
    }),
  );

  return {
    tools,
    clients,
    warnings,
    async closeAll() {
      await Promise.all(
        clients.map(async (entry) => {
          try {
            await entry.client.close();
          } catch {
            // ignore
          }
          try {
            await entry.close();
          } catch {
            // ignore
          }
        }),
      );
    },
  };
}
