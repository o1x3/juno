import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools, type ToolDeps } from '@/core/tools';
import type { ToolContext } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

async function context(): Promise<ToolContext> {
  workspace = await mkdtemp(join(tmpdir(), 'juno-websearch-'));
  return {
    cwd: workspace,
    outputLimit: 4_000,
    readLineLimit: 200,
    bashTimeoutMs: 1_000,
    sessionsDir: workspace,
    sessionId: 'websearch-test',
  };
}

function run(deps: ToolDeps, ctx: ToolContext, input: Record<string, unknown>) {
  const tool = createBuiltinTools(ctx, deps).find(
    (t) => t.name === 'WebSearch',
  );
  if (!tool) throw new Error('WebSearch tool missing');
  return tool.execute(input, ctx);
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('WebSearch tool', () => {
  test('happy path returns shaped results', async () => {
    const ctx = await context();
    const fetchImpl = async () =>
      jsonResponse({
        results: [
          {
            title: 'Bun',
            url: 'https://bun.sh',
            text: 'A fast JS runtime.',
            score: 0.9,
            publishedDate: '2025-01-01',
          },
          {
            title: 'Node',
            url: 'https://nodejs.org',
            summary: 'The original.',
          },
        ],
      });
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk_test' },
      ctx,
      { query: 'js runtime' },
    );
    expect(result.isError).toBeFalsy();
    const out = result.output as {
      results: { title: string; url: string; snippet: string }[];
      num_results: number;
      provider: string;
    };
    expect(out.provider).toBe('exa');
    expect(out.num_results).toBe(2);
    expect(out.results[0]?.url).toBe('https://bun.sh');
    expect(out.results[0]?.snippet).toContain('fast JS runtime');
    expect(out.results[1]?.snippet).toContain('original');
  });

  test('returns isError when EXA_API_KEY is not set', async () => {
    const ctx = await context();
    const result = await run({}, ctx, { query: 'anything' });
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('EXA_API_KEY');
  });

  test('rejects empty query', async () => {
    const ctx = await context();
    const result = await run({ exaApiKey: 'sk' }, ctx, { query: '' });
    expect(result.isError).toBe(true);
  });

  test('clamps max_results to the [1, 20] window', async () => {
    const ctx = await context();
    let observedBody: unknown;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse({ results: [] });
    };
    await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk' },
      ctx,
      { query: 'q', max_results: 9999 },
    );
    expect((observedBody as { numResults: number }).numResults).toBe(20);
  });

  test('passes allowed and blocked domains through', async () => {
    const ctx = await context();
    let observedBody: { includeDomains?: string[]; excludeDomains?: string[] } =
      {};
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      observedBody = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse({ results: [] });
    };
    await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk' },
      ctx,
      {
        query: 'q',
        allowed_domains: ['example.com'],
        blocked_domains: ['evil.com'],
      },
    );
    expect(observedBody.includeDomains).toEqual(['example.com']);
    expect(observedBody.excludeDomains).toEqual(['evil.com']);
  });

  test('surfaces auth errors clearly', async () => {
    const ctx = await context();
    const fetchImpl = async () => new Response('forbidden', { status: 401 });
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk_bad' },
      ctx,
      { query: 'q' },
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('auth');
  });

  test('surfaces rate limits', async () => {
    const ctx = await context();
    const fetchImpl = async () => new Response('429', { status: 429 });
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk' },
      ctx,
      { query: 'q' },
    );
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('rate-limited');
  });

  test('returns empty results array if Exa returns none', async () => {
    const ctx = await context();
    const fetchImpl = async () => jsonResponse({});
    const result = await run(
      { fetchImpl: fetchImpl as unknown as typeof fetch, exaApiKey: 'sk' },
      ctx,
      { query: 'q' },
    );
    expect(result.isError).toBeFalsy();
    expect((result.output as { num_results: number }).num_results).toBe(0);
  });
});
