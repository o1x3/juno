import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveCredential } from '@/auth/storage';
import { resolveAuthSummary } from '@/core/chat-service';
import { resetCodexRegistryCache } from '@/core/codex-models';
import type { AgentConfig } from '@/types';

let workspace = '';

async function seedCodexModelsCache(homeDir: string): Promise<void> {
  const dir = join(homeDir, 'cache');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'codex-models.json'),
    JSON.stringify({
      fetchedAt: Date.now(),
      models: [
        {
          // Cheapest in the registry but NOT supported on the ChatGPT-account
          // backend — must never be auto-selected for OAuth-Codex routing.
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

import { DEFAULT_UI } from '@/core/config';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    cwd: workspace,
    homeDir: workspace,
    configFile: join(workspace, 'config.json'),
    authFile: join(workspace, 'auth.json'),
    sessionsDir: join(workspace, 'sessions'),
    model: 'gpt-5.4-mini',
    planModel: 'gpt-5.4',
    execModel: 'gpt-5.4-mini',
    namingModel: 'gpt-5.4-nano',
    autoName: false,
    apiKey: undefined,
    maxSteps: 4,
    toolOutputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    codexBackendUrl: 'https://chatgpt.com/backend-api',
    ui: { ...DEFAULT_UI },
    autoUpgrade: false,
    updateCheckEnabled: false,
    yoloAcknowledged: false,
    snapshots: false,
    autoCompact: false,
    contextWindow: 272000,
    compactReserveTokens: 16384,
    compactKeepRecentTokens: 24000,
    multiAgent: false,
    multiAgentVersion: 'v2',
    ...overrides,
  };
}

beforeEach(async () => {
  resetCodexRegistryCache();
  workspace = await mkdtemp(join(tmpdir(), 'juno-routing-'));
  await seedCodexModelsCache(workspace);
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  resetCodexRegistryCache();
});

describe('resolveAuthSummary', () => {
  test('reports api-key mode when env apiKey is set', async () => {
    const config = makeConfig({ apiKey: 'sk-env' });
    const summary = await resolveAuthSummary(config);
    expect(summary.authMode).toBe('api-key');
    expect(summary.activeModel).toBe('gpt-5.4-mini');
    expect(summary.modelFallback).toBeUndefined();
  });

  test('reports oauth-codex routed to a safe default model, never the cheapest unsafe one', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      accountId: 'acct',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const config = makeConfig();
    const summary = await resolveAuthSummary(config);
    expect(summary.authMode).toBe('oauth-codex');
    // The configured model `gpt-5.4-mini` is in the seeded cache and is
    // ChatGPT-account-safe, so it should be picked verbatim. Critically,
    // gpt-5.1-codex-mini (cheapest in the cache) must not appear.
    expect(summary.activeModel).toBe('gpt-5.4-mini');
    expect(summary.activeModel).not.toBe('gpt-5.1-codex-mini');
    expect(summary.modelFallback).toBeUndefined();
  });

  test('reports none when no credential available', async () => {
    const config = makeConfig();
    const summary = await resolveAuthSummary(config);
    expect(summary.authMode).toBe('none');
  });

  test('reports none when an OAuth credential is missing both accountId and a JWT claim for it', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'not-a-jwt',
      refreshToken: 'rt',
      accountId: undefined,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const config = makeConfig();
    const summary = await resolveAuthSummary(config);
    // resolveAuthSummary swallows errors into 'none' so the UI can still
    // render. The underlying routing must throw rather than send an empty
    // chatgpt-account-id header.
    expect(summary.authMode).toBe('none');
  });

  test('reports oauth-api-key when oauth credential carries an exchanged api key', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      apiKey: 'sk-from-exchange',
      accountId: 'acct',
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const config = makeConfig();
    const summary = await resolveAuthSummary(config);
    expect(summary.authMode).toBe('oauth-api-key');
  });
});
