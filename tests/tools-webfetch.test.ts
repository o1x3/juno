import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools, type ToolDeps } from '@/core/tools';
import type { ToolContext, ToolResult } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

async function context(): Promise<ToolContext> {
  workspace = await mkdtemp(join(tmpdir(), 'juno-webfetch-'));
  return {
    cwd: workspace,
    outputLimit: 4_000,
    readLineLimit: 200,
    bashTimeoutMs: 1_000,
    sessionsDir: workspace,
    sessionId: 'webfetch-test',
  };
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    ...((init.headers as Record<string, string>) ?? {}),
  });
  return new Response(body, { ...init, headers });
}

function run(deps: ToolDeps, ctx: ToolContext, input: Record<string, unknown>) {
  const tool = createBuiltinTools(ctx, deps).find((t) => t.name === 'WebFetch');
  if (!tool) throw new Error('WebFetch tool missing');
  return tool.execute(input, ctx);
}

describe('WebFetch tool', () => {
  test('returns markdown for an html page', async () => {
    const ctx = await context();
    const fetchImpl = async () => htmlResponse('<h1>Hello</h1><p>World</p>');
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      ctx,
      { url: 'https://example.com' },
    );
    expect(result.isError).toBeFalsy();
    const out = result.output as {
      body: string;
      format: string;
      summarized: boolean;
    };
    expect(out.format).toBe('markdown');
    expect(out.body).toContain('# Hello');
    expect(out.summarized).toBe(false);
  });

  test('summarizes when prompt is provided and summarize is wired', async () => {
    const ctx = await context();
    const fetchImpl = async () =>
      htmlResponse('<h1>Animals</h1><p>cats and dogs</p>');
    let received: { prompt: string; content: string } | undefined;
    const result = await run(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        summarize: async ({ prompt, content }) => {
          received = { prompt, content };
          return `summary: ${prompt}`;
        },
      },
      ctx,
      { url: 'https://example.com', prompt: 'what animals?' },
    );
    expect((result.output as { summarized: boolean }).summarized).toBe(true);
    expect((result.output as { body: string }).body).toContain(
      'summary: what animals?',
    );
    expect(received?.prompt).toBe('what animals?');
    expect(received?.content).toContain('Animals');
  });

  test('skips summarize when no prompt is supplied', async () => {
    const ctx = await context();
    const fetchImpl = async () => htmlResponse('<p>plain</p>');
    let called = false;
    const result = await run(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        summarize: async () => {
          called = true;
          return 'never';
        },
      },
      ctx,
      { url: 'https://example.com' },
    );
    expect(called).toBe(false);
    expect((result.output as { summarized: boolean }).summarized).toBe(false);
  });

  test('falls back to raw body if summarize throws', async () => {
    const ctx = await context();
    const fetchImpl = async () => htmlResponse('<p>still here</p>');
    const result = await run(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        summarize: async () => {
          throw new Error('boom');
        },
      },
      ctx,
      { url: 'https://example.com', prompt: 'q' },
    );
    expect(result.isError).toBeFalsy();
    expect((result.output as { body: string }).body).toContain('still here');
    expect((result.output as { body: string }).body).toContain(
      'summarize failed: boom',
    );
  });

  test('returns isError for http-error', async () => {
    const ctx = await context();
    const fetchImpl = async () =>
      new Response('boom', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      ctx,
      { url: 'https://example.com/down' },
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('http-error');
  });

  test('returns isError for binary content', async () => {
    const ctx = await context();
    const fetchImpl = async () =>
      new Response('???', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      ctx,
      { url: 'https://example.com/x.png' },
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('binary');
  });

  test('returns isError for unsupported scheme', async () => {
    const ctx = await context();
    const result = await run({}, ctx, { url: 'file:///etc/hosts' });
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('unsupported-scheme');
  });

  test('reports upgraded:true for http://', async () => {
    const ctx = await context();
    const fetchImpl = async () => htmlResponse('<p>ok</p>');
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      ctx,
      { url: 'http://example.com' },
    );
    expect(result.isError).toBeFalsy();
    expect((result.output as { upgraded: boolean }).upgraded).toBe(true);
  });

  test('truncates large bodies via outputLimit', async () => {
    const ctx = await context();
    ctx.outputLimit = 50;
    const big = `<p>${'A'.repeat(5_000)}</p>`;
    const fetchImpl = async () => htmlResponse(big);
    const result = (await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      ctx,
      { url: 'https://example.com/big' },
    )) as ToolResult;
    const body = (result.output as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(120); // 50 + truncation marker
    expect(body).toContain('[truncated');
  });
});
