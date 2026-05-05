import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveCredential } from '@/auth/storage';
import { resolveAuthStatus } from '@/core/chat-service';
import { resetCodexRegistryCache } from '@/core/codex-models';
import type { AgentConfig, CredentialRecord } from '@/types';

let workspace = '';

const FULL_ACCOUNT_ID = '01HXYZACCOUNT123456789ABCDE3f9a';

async function seedCodexModelsCache(homeDir: string): Promise<void> {
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
    ...overrides,
  };
}

beforeEach(async () => {
  resetCodexRegistryCache();
  workspace = await mkdtemp(join(tmpdir(), 'juno-status-'));
  await seedCodexModelsCache(workspace);
});

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  resetCodexRegistryCache();
});

describe('resolveAuthStatus', () => {
  test('reports none with a hint when no credential and no env api key', async () => {
    const status = await resolveAuthStatus(makeConfig());
    expect(status.authMode).toBe('none');
    expect(status.source).toBe('none');
    expect(status.provider).toBe('none');
    expect(status.credentialType).toBeUndefined();
    expect(status.accountIdPresent).toBe(false);
    expect(status.accountIdPartial).toBeUndefined();
    expect(status.expiresAt).toBeUndefined();
    expect(status.hint).toBe('Run `juno login` or set OPENAI_API_KEY.');
    expect(status.configuredModel).toBe('gpt-5.4-mini');
    expect(status.activeModel).toBe('gpt-5.4-mini');
  });

  test('reports api-key mode with env source when OPENAI_API_KEY is set', async () => {
    const status = await resolveAuthStatus(
      makeConfig({ apiKey: 'sk-env-test' }),
    );
    expect(status.authMode).toBe('api-key');
    expect(status.source).toBe('env');
    expect(status.provider).toBe('codex');
    expect(status.credentialType).toBe('api-key');
    expect(status.accountIdPresent).toBe(false);
    expect(status.expiresAt).toBeUndefined();
    expect(status.hint).toBeUndefined();
  });

  test('reports api-key mode with stored source for a stored API key', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'api-key',
      apiKey: 'sk-stored',
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(makeConfig());
    expect(status.authMode).toBe('api-key');
    expect(status.source).toBe('stored');
    expect(status.credentialType).toBe('api-key');
    expect(status.accountIdPresent).toBe(false);
    expect(status.expiresAt).toBeUndefined();
  });

  test('reports oauth-api-key with stored source, partial account id, and expiry', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      apiKey: 'sk-from-exchange',
      accountId: FULL_ACCOUNT_ID,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(makeConfig());
    expect(status.authMode).toBe('oauth-api-key');
    expect(status.source).toBe('stored');
    expect(status.credentialType).toBe('oauth');
    expect(status.accountIdPresent).toBe(true);
    expect(status.accountIdPartial).toBe(`…${FULL_ACCOUNT_ID.slice(-4)}`);
    expect(status.accountIdPartial).not.toContain(FULL_ACCOUNT_ID);
    expect(status.expiresAt).toBe(expiresAt);
    expect(status.refreshDueSoon).toBe(false);
    expect((status.expiresInSeconds ?? 0) > 1800).toBe(true);
  });

  test('reports oauth-codex routed to a safe model with no fallback when configured model is safe', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      accountId: FULL_ACCOUNT_ID,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(makeConfig());
    expect(status.authMode).toBe('oauth-codex');
    expect(status.activeModel).toBe('gpt-5.4-mini');
    expect(status.activeModel).not.toBe('gpt-5.1-codex-mini');
    expect(status.modelFallback).toBeUndefined();
  });

  test('reports oauth-codex with a model fallback when configured model is unsafe', async () => {
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      accountId: FULL_ACCOUNT_ID,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(
      makeConfig({ model: 'gpt-5.1-codex-mini' }),
    );
    expect(status.authMode).toBe('oauth-codex');
    expect(status.modelFallback).toBeDefined();
    expect(status.modelFallback?.from).toBe('gpt-5.1-codex-mini');
    expect(status.modelFallback?.to).toBe(status.activeModel);
    expect(status.activeModel).not.toBe('gpt-5.1-codex-mini');
  });

  test('flags refresh-due-soon when oauth credential is within the refresh skew window', async () => {
    const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      apiKey: 'sk-from-exchange',
      accountId: FULL_ACCOUNT_ID,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(makeConfig());
    expect(status.refreshDueSoon).toBe(true);
    expect((status.expiresInSeconds ?? Number.POSITIVE_INFINITY) <= 300).toBe(
      true,
    );
  });

  test('CLI prints "auth: none" and the login hint against an empty home', async () => {
    const scriptPath = join(import.meta.dir, '..', 'src', 'cli', 'index.tsx');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value !== undefined &&
        key !== 'NODE_ENV' &&
        key !== 'OPENAI_API_KEY' &&
        key !== 'JUNO_HOME'
      ) {
        env[key] = value;
      }
    }
    env.JUNO_HOME = workspace;

    const cli = Bun.spawnSync({
      cmd: [process.execPath, scriptPath, 'auth', 'status'],
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = cli.stdout.toString();
    expect(cli.exitCode).toBe(0);
    expect(stdout).toContain('auth: none');
    expect(stdout).toContain('Run `juno login` or set OPENAI_API_KEY.');
  });

  test('within-skew refresh: printed status reflects the refreshed credential, not the stale snapshot', async () => {
    // Pre-stored credential is within the 5-minute refresh window.
    const STALE_ACCOUNT_ID = 'acct-stale-0000-0000-0000-stale123';
    const STALE_EXPIRES_AT = new Date(Date.now() + 60 * 1000).toISOString();
    const REFRESHED_ACCOUNT_ID = 'acct-fresh-1111-1111-1111-fresh999';
    const REFRESHED_EXPIRES_AT_MS = Date.now() + 3600 * 1000;
    const REFRESHED_EXPIRES_AT = new Date(
      REFRESHED_EXPIRES_AT_MS,
    ).toISOString();

    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'stale-access',
      refreshToken: 'rt',
      apiKey: 'sk-from-exchange',
      accountId: STALE_ACCOUNT_ID,
      expiresAt: STALE_EXPIRES_AT,
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    });

    let refresherCalls = 0;
    const refreshed: CredentialRecord = {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'fresh-access',
      refreshToken: 'rt-new',
      apiKey: 'sk-from-exchange',
      accountId: REFRESHED_ACCOUNT_ID,
      expiresAt: REFRESHED_EXPIRES_AT,
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };

    const status = await resolveAuthStatus(makeConfig(), {
      refresher: async () => {
        refresherCalls += 1;
        return refreshed;
      },
    });

    expect(refresherCalls).toBe(1);
    expect(status.authMode).toBe('oauth-api-key');
    // The bug being guarded against: status used to derive these fields
    // from the pre-refresh snapshot loaded BEFORE resolveAuthSummary ran.
    expect(status.expiresAt).toBe(REFRESHED_EXPIRES_AT);
    expect(status.expiresAt).not.toBe(STALE_EXPIRES_AT);
    expect(status.accountIdPartial).toBe(`…${REFRESHED_ACCOUNT_ID.slice(-4)}`);
    expect(status.accountIdPartial).not.toBe(`…${STALE_ACCOUNT_ID.slice(-4)}`);
    // Refreshed credential expires in ~1h, well outside the 5-min window.
    expect(status.refreshDueSoon).toBe(false);
    expect((status.expiresInSeconds ?? 0) > 1800).toBe(true);
  });

  test('reports authMode none and surfaces stored expiry when oauth credential lacks accountId and JWT claim', async () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await saveCredential(join(workspace, 'auth.json'), {
      provider: 'codex',
      type: 'oauth',
      accessToken: 'not-a-jwt',
      refreshToken: 'rt',
      accountId: undefined,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
    const status = await resolveAuthStatus(makeConfig());
    // routing throws → summary swallows to 'none'
    expect(status.authMode).toBe('none');
    expect(status.hint).toBe('Run `juno login` or set OPENAI_API_KEY.');
    // but we still surface what's on disk so the user knows they have a credential
    expect(status.source).toBe('stored');
    expect(status.credentialType).toBe('oauth');
    expect(status.accountIdPresent).toBe(false);
    expect(status.expiresAt).toBe(expiresAt);
  });
});
