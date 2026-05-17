import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  availableLspServerIds,
  type LspConnect,
  runLspOperation,
  serverForFile,
} from '@/core/lsp';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

let workspace = '';
afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('lsp server registry', () => {
  test('serverForFile maps extensions to servers', () => {
    expect(serverForFile('/a/b.ts')?.id).toBe('typescript');
    expect(serverForFile('/a/b.py')?.id).toBe('pyright');
    expect(serverForFile('/a/b.go')?.id).toBe('gopls');
    expect(serverForFile('/a/b.unknownext')).toBeUndefined();
  });

  test('availableLspServerIds uses the injected which probe', () => {
    const ids = availableLspServerIds((cmd) => cmd === 'gopls');
    expect(ids.has('gopls')).toBe(true);
    expect(ids.has('typescript')).toBe(false);
  });
});

type Recorded = { method: string; params: unknown };

function fakeConnect(
  recorded: Recorded[],
  responses: Record<string, unknown>,
): LspConnect {
  return async () => ({
    async request(method, params) {
      recorded.push({ method, params });
      return responses[method] ?? null;
    },
    notify(method, params) {
      recorded.push({ method, params });
    },
    async close() {},
  });
}

describe('runLspOperation', () => {
  test('initialize + didOpen handshake then the operation, 1→0 based pos', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-'));
    const file = join(workspace, 'a.ts');
    await writeFile(file, 'export const x = 1;\n');
    const rec: Recorded[] = [];
    const result = await runLspOperation(
      {
        operation: 'goToDefinition',
        filePath: file,
        line: 1,
        character: 14,
        cwd: workspace,
      },
      fakeConnect(rec, {
        'textDocument/definition': [{ uri: 'file://x', range: {} }],
      }),
    );
    expect(result).toEqual([{ uri: 'file://x', range: {} }]);
    const methods = rec.map((r) => r.method);
    expect(methods[0]).toBe('initialize');
    expect(methods).toContain('initialized');
    expect(methods).toContain('textDocument/didOpen');
    const def = rec.find((r) => r.method === 'textDocument/definition');
    expect((def?.params as { position: unknown }).position).toEqual({
      line: 0,
      character: 13,
    });
  });

  test('workspaceSymbol passes the query', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-ws-'));
    const file = join(workspace, 'a.ts');
    await writeFile(file, 'x');
    const rec: Recorded[] = [];
    await runLspOperation(
      {
        operation: 'workspaceSymbol',
        filePath: file,
        line: 1,
        character: 1,
        query: 'Foo',
        cwd: workspace,
      },
      fakeConnect(rec, {}),
    );
    const ws = rec.find((r) => r.method === 'workspace/symbol');
    expect((ws?.params as { query: string }).query).toBe('Foo');
  });

  test('incomingCalls prepares the call hierarchy first', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-ic-'));
    const file = join(workspace, 'a.ts');
    await writeFile(file, 'x');
    const rec: Recorded[] = [];
    const result = await runLspOperation(
      {
        operation: 'incomingCalls',
        filePath: file,
        line: 2,
        character: 3,
        cwd: workspace,
      },
      fakeConnect(rec, {
        'textDocument/prepareCallHierarchy': [{ name: 'fn' }],
        'callHierarchy/incomingCalls': [{ from: { name: 'caller' } }],
      }),
    );
    expect(result).toEqual([{ from: { name: 'caller' } }]);
    expect(
      rec.some((r) => r.method === 'textDocument/prepareCallHierarchy'),
    ).toBe(true);
  });

  test('unsupported language throws', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-x-'));
    await expect(
      runLspOperation(
        {
          operation: 'hover',
          filePath: join(workspace, 'a.unknownext'),
          line: 1,
          character: 1,
          cwd: workspace,
        },
        fakeConnect([], {}),
      ),
    ).rejects.toThrow('no LSP server available');
  });
});

function ctx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 50_000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

describe('LSP tool', () => {
  test('not registered when no servers available', () => {
    const names = createBuiltinTools(
      {
        cwd: '/tmp',
        outputLimit: 1,
        readLineLimit: 1,
        bashTimeoutMs: 1,
        sessionsDir: '/tmp',
        sessionId: 't',
      },
      {},
    ).map((t) => t.name);
    expect(names).not.toContain('LSP');
  });

  test('registered + returns JSON result when a server is available', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-tool-'));
    const file = join(workspace, 'm.ts');
    await writeFile(file, 'export function f() {}\n');
    const rec: Recorded[] = [];
    const tool = createBuiltinTools(ctx(), {
      lspServerIds: new Set(['typescript']),
      lspConnect: fakeConnect(rec, {
        'textDocument/hover': { contents: 'function f(): void' },
      }),
    }).find((t) => t.name === 'LSP') as ToolSpec;
    expect(tool).toBeDefined();

    const r = await tool.execute(
      {
        operation: 'hover',
        filePath: 'm.ts',
        line: 1,
        character: 17,
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const o = r.output as {
      operation: string;
      server: string;
      empty: boolean;
      text: string;
    };
    expect(o.operation).toBe('hover');
    expect(o.server).toBe('typescript');
    expect(o.empty).toBe(false);
    expect(o.text).toContain('function f(): void');
  });

  test('empty result reports "No results found"', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-empty-'));
    const file = join(workspace, 'm.ts');
    await writeFile(file, 'x');
    const tool = createBuiltinTools(ctx(), {
      lspServerIds: new Set(['typescript']),
      lspConnect: fakeConnect([], { 'textDocument/definition': [] }),
    }).find((t) => t.name === 'LSP') as ToolSpec;
    const r = await tool.execute(
      {
        operation: 'goToDefinition',
        filePath: 'm.ts',
        line: 1,
        character: 1,
        toolCallId: '1',
      },
      ctx(),
    );
    expect((r.output as { empty: boolean }).empty).toBe(true);
    expect((r.output as { text: string }).text).toContain('No results found');
  });

  test('file not found is a clear error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-nf-'));
    const tool = createBuiltinTools(ctx(), {
      lspServerIds: new Set(['typescript']),
      lspConnect: fakeConnect([], {}),
    }).find((t) => t.name === 'LSP') as ToolSpec;
    const r = await tool.execute(
      {
        operation: 'hover',
        filePath: 'nope.ts',
        line: 1,
        character: 1,
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('File not found');
  });

  test('no server for this file type → friendly error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-lsp-nos-'));
    await writeFile(join(workspace, 'a.txt'), 'plain');
    const tool = createBuiltinTools(ctx(), {
      lspServerIds: new Set(['typescript']),
      lspConnect: fakeConnect([], {}),
    }).find((t) => t.name === 'LSP') as ToolSpec;
    const r = await tool.execute(
      {
        operation: 'hover',
        filePath: 'a.txt',
        line: 1,
        character: 1,
        toolCallId: '1',
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('No LSP server available');
  });
});
