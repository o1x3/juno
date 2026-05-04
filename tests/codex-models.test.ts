import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  discoverCodexModels,
  pickCodexModel,
  pickDefaultCodexModel,
  resetCodexRegistryCache,
} from '@/core/codex-models';

const SAMPLE_PAYLOAD = {
  openai: {
    models: {
      'gpt-5.1-codex-mini': {
        id: 'gpt-5.1-codex-mini',
        family: 'gpt-codex',
        reasoning: true,
        tool_call: true,
        cost: { input: 0.25, output: 2, cache_read: 0.025 },
        limit: { context: 400000 },
      },
      'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        family: 'gpt-codex',
        reasoning: true,
        tool_call: true,
        cost: { input: 1.75, output: 14, cache_read: 0.175 },
        limit: { context: 400000 },
      },
      'gpt-5-chat-no-tools': {
        id: 'gpt-5-chat-no-tools',
        family: 'gpt-codex',
        reasoning: true,
        tool_call: false,
        cost: { input: 1.25, output: 10 },
        limit: { context: 400000 },
      },
      'gpt-4.1-mini': {
        id: 'gpt-4.1-mini',
        family: 'gpt-4.1',
        reasoning: false,
        tool_call: true,
        cost: { input: 0.4, output: 1.6 },
        limit: { context: 128000 },
      },
    },
  },
};

let workspace = '';

beforeEach(async () => {
  resetCodexRegistryCache();
  workspace = await mkdtemp(join(tmpdir(), 'juno-models-'));
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  resetCodexRegistryCache();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('discoverCodexModels', () => {
  test('fetches fresh registry, projects family=gpt-codex with tool_call=true, persists cache', async () => {
    const fetcher = async () => jsonResponse(SAMPLE_PAYLOAD);
    const registry = await discoverCodexModels({
      homeDir: workspace,
      fetcher,
    });
    expect(registry.source).toBe('fresh');
    expect(registry.models.map((m) => m.id).sort()).toEqual([
      'gpt-5.1-codex-mini',
      'gpt-5.3-codex',
    ]);
    const cached = JSON.parse(
      await readFile(join(workspace, 'cache', 'codex-models.json'), 'utf8'),
    ) as { models: Array<{ id: string }> };
    expect(cached.models.map((m) => m.id).sort()).toEqual([
      'gpt-5.1-codex-mini',
      'gpt-5.3-codex',
    ]);
  });

  test('returns cache when within ttl without calling fetcher', async () => {
    await writeFile(
      join(workspace, 'cache', 'codex-models.json'),
      JSON.stringify({
        fetchedAt: 100,
        models: [
          {
            id: 'gpt-5.1-codex-mini',
            inputCost: 0.25,
            outputCost: 2,
            reasoning: true,
            contextLimit: 400000,
          },
        ],
      }),
      { flag: 'wx' },
    ).catch(async () => {
      // Directory may not exist yet, write through writeCache equivalent
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(workspace, 'cache'), { recursive: true });
      await writeFile(
        join(workspace, 'cache', 'codex-models.json'),
        JSON.stringify({
          fetchedAt: 100,
          models: [
            {
              id: 'gpt-5.1-codex-mini',
              inputCost: 0.25,
              outputCost: 2,
              reasoning: true,
              contextLimit: 400000,
            },
          ],
        }),
      );
    });

    let fetcherCalled = false;
    const registry = await discoverCodexModels({
      homeDir: workspace,
      fetcher: async () => {
        fetcherCalled = true;
        return jsonResponse(SAMPLE_PAYLOAD);
      },
      now: () => 200,
      ttlMs: 1000,
    });
    expect(registry.source).toBe('cache');
    expect(fetcherCalled).toBe(false);
    expect(registry.models[0]?.id).toBe('gpt-5.1-codex-mini');
  });

  test('falls back to static when no cache and fetcher throws', async () => {
    const registry = await discoverCodexModels({
      homeDir: workspace,
      fetcher: async () => {
        throw new Error('offline');
      },
    });
    expect(registry.source).toBe('static');
    expect(registry.models.length).toBeGreaterThan(0);
  });
});

describe('pickDefaultCodexModel', () => {
  test('picks cheapest by input+output cost', () => {
    const id = pickDefaultCodexModel([
      {
        id: 'gpt-5.3-codex',
        inputCost: 1.75,
        outputCost: 14,
        reasoning: true,
        contextLimit: 400000,
      },
      {
        id: 'gpt-5.1-codex-mini',
        inputCost: 0.25,
        outputCost: 2,
        reasoning: true,
        contextLimit: 400000,
      },
    ]);
    expect(id).toBe('gpt-5.1-codex-mini');
  });
});

describe('pickCodexModel', () => {
  const registry = {
    models: [
      {
        id: 'gpt-5.1-codex-mini',
        inputCost: 0.25,
        outputCost: 2,
        reasoning: true,
        contextLimit: 400000,
      },
    ],
    source: 'fresh' as const,
  };

  test('honors override unconditionally', () => {
    expect(pickCodexModel('gpt-5.4-mini', 'custom-model', registry)).toEqual({
      model: 'custom-model',
      source: 'fresh',
    });
  });

  test('keeps configured model when in registry', () => {
    expect(pickCodexModel('gpt-5.1-codex-mini', undefined, registry)).toEqual({
      model: 'gpt-5.1-codex-mini',
      source: 'fresh',
    });
  });

  test('falls back when configured model is not in registry', () => {
    const choice = pickCodexModel('gpt-5.4-mini', undefined, registry);
    expect(choice.model).toBe('gpt-5.1-codex-mini');
    expect(choice.fallbackFrom).toBe('gpt-5.4-mini');
  });
});
