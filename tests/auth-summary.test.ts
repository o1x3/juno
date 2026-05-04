import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveCredential } from '@/auth/storage';
import { resolveAuthSummary } from '@/core/chat-service';
import { resetCodexRegistryCache } from '@/core/codex-models';
import type { AgentConfig } from '@/types';

let workspace = '';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    cwd: workspace,
    homeDir: workspace,
    authFile: join(workspace, 'auth.json'),
    sessionsDir: join(workspace, 'sessions'),
    model: 'gpt-5.4-mini',
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
  workspace = await mkdtemp(join(tmpdir(), 'juno-routing-'));
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

  test('reports oauth-codex with fallback when only OAuth credential is stored and configured model is non-codex', async () => {
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
    expect(summary.modelFallback).toBeDefined();
    expect(summary.modelFallback?.from).toBe('gpt-5.4-mini');
  });

  test('reports none when no credential available', async () => {
    const config = makeConfig();
    const summary = await resolveAuthSummary(config);
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
