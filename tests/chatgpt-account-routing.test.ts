// Regression test for the runtime failure:
//   Codex backend error 400: {"detail":"The 'gpt-5.1-codex-mini' model is not
//   supported when using Codex with a ChatGPT account."}
//
// 1) End-to-end: an OAuth-only credential, with a registry that contains both
//    an unsafe-but-cheap slug and a safe slug, must resolve to the safe slug.
// 2) Backend rejection path: the friendly error must name the offending model
//    and surface the safe model hint so the user knows how to recover.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveCredential } from '@/auth/storage';
import { resolveAuthSummary } from '@/core/chat-service';
import { resetCodexRegistryCache } from '@/core/codex-models';
import { createCodexResponsesClient } from '@/core/codex-responses-client';
import type { AgentConfig } from '@/types';

const FAKE_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' },
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
})();

let workspace = '';

async function seedMixedRegistry(homeDir: string): Promise<void> {
  const dir = join(homeDir, 'cache');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'codex-models.json'),
    JSON.stringify({
      fetchedAt: Date.now(),
      models: [
        {
          id: 'gpt-5.1-codex-mini',
          inputCost: 0.25,
          outputCost: 2,
          reasoning: true,
          contextLimit: 400000,
        },
        {
          id: 'gpt-5.4-mini',
          inputCost: 0.75,
          outputCost: 4.5,
          reasoning: true,
          contextLimit: 272000,
        },
      ],
    }),
  );
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    cwd: workspace,
    homeDir: workspace,
    authFile: join(workspace, 'auth.json'),
    sessionsDir: join(workspace, 'sessions'),
    model: 'gpt-not-in-registry',
    apiKey: undefined,
    maxSteps: 4,
    toolOutputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    codexBackendUrl: 'https://chatgpt.com/backend-api',
    ...overrides,
  };
}

beforeEach(async () => {
  resetCodexRegistryCache();
  workspace = await mkdtemp(join(tmpdir(), 'juno-chatgpt-routing-'));
  await seedMixedRegistry(workspace);
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  resetCodexRegistryCache();
});

describe('ChatGPT-account Codex routing', () => {
  test('OAuth-only credential never auto-selects gpt-5.1-codex-mini even when it is the cheapest model in the registry', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: FAKE_JWT,
      refreshToken: 'rt',
      accountId: 'acct',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const summary = await resolveAuthSummary(makeConfig());
    expect(summary.authMode).toBe('oauth-codex');
    expect(summary.activeModel).toBe('gpt-5.4-mini');
    expect(summary.activeModel).not.toBe('gpt-5.1-codex-mini');
    expect(summary.modelFallback?.from).toBe('gpt-not-in-registry');
    expect(summary.modelFallback?.to).toBe('gpt-5.4-mini');
  });

  test("backend 400 'not supported when using Codex with a ChatGPT account' is rewrapped with a safe-model hint", async () => {
    const observed400Body = JSON.stringify({
      detail:
        "The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account.",
    });
    const fakeFetch = (async () => {
      return new Response(observed400Body, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct',
      fetchImpl: fakeFetch,
    });

    let thrown: Error | undefined;
    try {
      await client.runStep({
        // The user has explicitly forced an unsafe slug via JUNO_CODEX_MODEL,
        // so the picker honored their override and the backend rejected it.
        model: 'gpt-5.1-codex-mini',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/gpt-5\.1-codex-mini/);
    expect(thrown?.message).toMatch(
      /not supported when using Codex with a ChatGPT account/i,
    );
    expect(thrown?.message).toMatch(/gpt-5\.4-mini/);
    expect(thrown?.message).toMatch(/JUNO_CODEX_MODEL/);
  });
});
