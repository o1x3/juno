import { pathToFileURL } from 'node:url';

// Minimal Language Server Protocol client. Mirrors the operation set of
// opencode's experimental `lsp` tool. The transport is injectable so the tool
// can be tested hermetically against a fake server (no real language server
// binary required in CI), and in production it spawns the right stdio server
// for the file's language.

export type LspOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';

export const LSP_OPERATIONS: LspOperation[] = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
];

export type LspServerSpec = { id: string; command: string; args: string[] };

// Extension → language server. The command must resolve on PATH for the tool
// to be offered (mirrors opencode only exposing `lsp` when a client exists).
const SERVERS: Record<string, LspServerSpec> = {
  ts: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  tsx: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  js: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  jsx: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  mjs: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  cjs: {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  py: { id: 'pyright', command: 'pyright-langserver', args: ['--stdio'] },
  go: { id: 'gopls', command: 'gopls', args: [] },
  rs: { id: 'rust-analyzer', command: 'rust-analyzer', args: [] },
  c: { id: 'clangd', command: 'clangd', args: [] },
  h: { id: 'clangd', command: 'clangd', args: [] },
  cpp: { id: 'clangd', command: 'clangd', args: [] },
  hpp: { id: 'clangd', command: 'clangd', args: [] },
  cc: { id: 'clangd', command: 'clangd', args: [] },
};

export function serverForFile(filePath: string): LspServerSpec | undefined {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  return SERVERS[ext];
}

function resolveOnPath(command: string): boolean {
  try {
    return Boolean(Bun.which(command));
  } catch {
    return false;
  }
}

/** The set of language-server ids whose binary is resolvable on PATH. */
export function availableLspServerIds(
  whichImpl: (cmd: string) => boolean = resolveOnPath,
): Set<string> {
  const ids = new Set<string>();
  for (const spec of Object.values(SERVERS)) {
    if (!ids.has(spec.id) && whichImpl(spec.command)) ids.add(spec.id);
  }
  return ids;
}

export type LspConnection = {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
};

export type LspConnect = (
  spec: LspServerSpec,
  cwd: string,
) => Promise<LspConnection>;

// --- stdio JSON-RPC transport (Content-Length framed) -----------------------

function frame(msg: unknown): Uint8Array {
  const body = JSON.stringify(msg);
  return new TextEncoder().encode(
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
  );
}

class FrameReader {
  private buf = Buffer.alloc(0);
  push(chunk: Uint8Array): object[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: object[] = [];
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        // skip malformed frame
      }
    }
    return out;
  }
}

const spawnConnect: LspConnect = async (spec, cwd) => {
  const proc = Bun.spawn({
    cmd: [spec.command, ...spec.args],
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = new FrameReader();
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let nextId = 1;

  (async () => {
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        for (const msg of reader.push(chunk)) {
          const m = msg as {
            id?: number;
            result?: unknown;
            error?: unknown;
          };
          if (typeof m.id === 'number' && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) p?.reject(m.error);
            else p?.resolve(m.result ?? null);
          }
        }
      }
    } catch {
      // stream closed
    }
  })();

  const writer = proc.stdin as unknown as {
    write: (d: Uint8Array) => void;
    flush?: () => void;
  };

  return {
    request(method, params) {
      const id = nextId++;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      writer.write(frame({ jsonrpc: '2.0', id, method, params }));
      writer.flush?.();
      return promise;
    },
    notify(method, params) {
      writer.write(frame({ jsonrpc: '2.0', method, params }));
      writer.flush?.();
    },
    async close() {
      try {
        writer.write(
          frame({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' }),
        );
        writer.write(frame({ jsonrpc: '2.0', method: 'exit' }));
        writer.flush?.();
      } catch {
        // ignore
      }
      proc.kill();
      await proc.exited.catch(() => {});
    },
  };
};

// --- operation runner -------------------------------------------------------

const METHOD: Record<LspOperation, string> = {
  goToDefinition: 'textDocument/definition',
  findReferences: 'textDocument/references',
  hover: 'textDocument/hover',
  documentSymbol: 'textDocument/documentSymbol',
  workspaceSymbol: 'workspace/symbol',
  goToImplementation: 'textDocument/implementation',
  prepareCallHierarchy: 'textDocument/prepareCallHierarchy',
  incomingCalls: 'callHierarchy/incomingCalls',
  outgoingCalls: 'callHierarchy/outgoingCalls',
};

export type LspRunInput = {
  operation: LspOperation;
  filePath: string; // absolute
  /** 1-based, as shown in editors (converted to 0-based for the protocol). */
  line: number;
  /** 1-based, as shown in editors. */
  character: number;
  query?: string;
  cwd: string;
};

export async function runLspOperation(
  input: LspRunInput,
  connect: LspConnect = spawnConnect,
  readFileText: (p: string) => Promise<string> = (p) => Bun.file(p).text(),
): Promise<unknown> {
  const spec = serverForFile(input.filePath);
  if (!spec) {
    throw new Error(
      `no LSP server available for ${input.filePath} (unsupported language)`,
    );
  }
  const conn = await connect(spec, input.cwd);
  try {
    const rootUri = pathToFileURL(input.cwd).href;
    await conn.request('initialize', {
      processId: null,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
    });
    conn.notify('initialized', {});

    const uri = pathToFileURL(input.filePath).href;
    const text = await readFileText(input.filePath);
    const languageId = spec.id;
    conn.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });

    const pos = {
      line: Math.max(0, input.line - 1),
      character: Math.max(0, input.character - 1),
    };
    const td = { uri };
    let result: unknown;
    switch (input.operation) {
      case 'goToDefinition':
      case 'goToImplementation':
      case 'hover':
        result = await conn.request(METHOD[input.operation], {
          textDocument: td,
          position: pos,
        });
        break;
      case 'findReferences':
        result = await conn.request(METHOD.findReferences, {
          textDocument: td,
          position: pos,
          context: { includeDeclaration: true },
        });
        break;
      case 'documentSymbol':
        result = await conn.request(METHOD.documentSymbol, {
          textDocument: td,
        });
        break;
      case 'workspaceSymbol':
        result = await conn.request(METHOD.workspaceSymbol, {
          query: input.query ?? '',
        });
        break;
      case 'prepareCallHierarchy':
        result = await conn.request(METHOD.prepareCallHierarchy, {
          textDocument: td,
          position: pos,
        });
        break;
      case 'incomingCalls':
      case 'outgoingCalls': {
        const items = (await conn.request('textDocument/prepareCallHierarchy', {
          textDocument: td,
          position: pos,
        })) as unknown[] | null;
        const item = Array.isArray(items) ? items[0] : undefined;
        if (!item) {
          result = null;
          break;
        }
        result = await conn.request(METHOD[input.operation], { item });
        break;
      }
    }
    return result;
  } finally {
    await conn.close();
  }
}
