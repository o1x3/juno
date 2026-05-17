import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { connectMcpServers, loadMcpConfig, sanitizeToolName } from '@/core/mcp';

const STUB = resolve('tests/_mcp-stub.ts');

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('mcp config loader', () => {
  test('returns empty when no config exists', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-mcp-empty-'));
    const home = await mkdtemp(join(tmpdir(), 'juno-mcp-home-'));
    try {
      const { servers, sources } = await loadMcpConfig({
        cwd: workspace,
        homeDir: home,
      });
      expect(servers).toEqual({});
      expect(sources).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('cwd .mcp.json overrides home mcp.json on the same key', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-mcp-cwd-'));
    const home = await mkdtemp(join(tmpdir(), 'juno-mcp-home-'));
    try {
      await writeFile(
        join(home, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            base: { type: 'local', command: 'home-cmd' },
            only_home: { type: 'local', command: 'home-only' },
          },
        }),
      );
      await writeFile(
        join(workspace, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            base: { type: 'local', command: 'cwd-cmd' },
            only_cwd: { type: 'local', command: 'cwd-only' },
          },
        }),
      );
      const { servers, sources } = await loadMcpConfig({
        cwd: workspace,
        homeDir: home,
      });
      expect(Object.keys(servers).sort()).toEqual([
        'base',
        'only_cwd',
        'only_home',
      ]);
      expect(servers.base?.type).toBe('local');
      if (servers.base?.type === 'local') {
        expect(servers.base.command).toBe('cwd-cmd');
      }
      expect(sources.length).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('rejects malformed json with a clear error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-mcp-bad-'));
    const home = await mkdtemp(join(tmpdir(), 'juno-mcp-home-bad-'));
    try {
      await writeFile(
        join(workspace, '.mcp.json'),
        JSON.stringify({
          mcpServers: { broken: { type: 'local' } },
        }),
      );
      await expect(
        loadMcpConfig({ cwd: workspace, homeDir: home }),
      ).rejects.toThrow(/Invalid MCP config/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('sanitizeToolName', () => {
  test('combines server and tool names with safe chars', () => {
    expect(sanitizeToolName('exa', 'web_search')).toBe('exa_web_search');
    expect(sanitizeToolName('my-server', 'do.thing')).toBe(
      'my_server_do_thing',
    );
  });
});

describe('connectMcpServers (stdio)', () => {
  test('registers tools and routes calls to a real subprocess', async () => {
    const registry = await connectMcpServers({
      servers: {
        stub: {
          type: 'local',
          command: process.execPath,
          args: [STUB],
        },
      },
    });
    try {
      expect(registry.warnings).toEqual([]);
      expect(registry.tools.length).toBe(2);
      const echo = registry.tools.find((t) => t.name === 'stub_echo');
      const add = registry.tools.find((t) => t.name === 'stub_add');
      expect(echo).toBeTruthy();
      expect(add).toBeTruthy();
      expect(echo?.parameters).toEqual({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      });

      const ctx = {
        cwd: '/tmp',
        outputLimit: 2_000,
        readLineLimit: 100,
        bashTimeoutMs: 1_000,
        sessionsDir: '/tmp',
        sessionId: 'mcp-test',
      };
      if (!echo || !add) throw new Error('expected stub tools');
      const result = await echo.execute(
        { text: 'hello', toolCallId: '1' },
        ctx,
      );
      expect(result.isError).toBeFalsy();
      const out = result.output as {
        content?: { type: string; text?: string }[];
      };
      expect(out.content?.[0]?.text).toBe('hello');

      const sumResult = await add.execute({ a: 2, b: 3, toolCallId: '2' }, ctx);
      const sumOut = sumResult.output as {
        content?: { type: string; text?: string }[];
      };
      expect(sumOut.content?.[0]?.text).toBe('5');
    } finally {
      await registry.closeAll();
    }
  });

  test('isolates a bad server without aborting healthy ones', async () => {
    const registry = await connectMcpServers({
      servers: {
        ok: { type: 'local', command: process.execPath, args: [STUB] },
        nope: { type: 'local', command: 'definitely_not_a_real_binary_xyz' },
      },
    });
    try {
      expect(registry.warnings.some((w) => w.startsWith('mcp:nope'))).toBe(
        true,
      );
      expect(registry.tools.length).toBe(2);
      expect(registry.tools.every((t) => t.name.startsWith('ok_'))).toBe(true);
    } finally {
      await registry.closeAll();
    }
  });

  test('approvalGate blocks tool execution when it rejects', async () => {
    const registry = await connectMcpServers({
      servers: {
        stub: { type: 'local', command: process.execPath, args: [STUB] },
      },
      approvalGate: async () => ({ approved: false, reason: 'nope' }),
    });
    try {
      const echo = registry.tools.find((t) => t.name === 'stub_echo');
      const ctx = {
        cwd: '/tmp',
        outputLimit: 2_000,
        readLineLimit: 100,
        bashTimeoutMs: 1_000,
        sessionsDir: '/tmp',
        sessionId: 'mcp-test',
      };
      if (!echo) throw new Error('expected stub echo tool');
      const result = await echo.execute({ text: 'hi', toolCallId: '1' }, ctx);
      expect(result.isError).toBe(true);
      expect(String(result.output)).toContain('user rejected mcp:stub/echo');
      expect(String(result.output)).toContain('nope');
    } finally {
      await registry.closeAll();
    }
  });
});
