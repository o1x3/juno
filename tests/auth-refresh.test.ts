import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadCredential,
  refreshCredentialIfNearExpiry,
  saveCredential,
} from '@/auth/storage';
import type { CredentialRecord } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

const baseOauth = (
  expiresInSeconds: number,
  now: number,
): CredentialRecord & { type: 'oauth' } => ({
  provider: 'codex',
  type: 'oauth',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  accountId: 'acct-1',
  expiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
  createdAt: new Date(now - 3600 * 1000).toISOString(),
});

describe('refreshCredentialIfNearExpiry', () => {
  test('no-ops for api-key credentials', async () => {
    const result = await refreshCredentialIfNearExpiry(
      '/tmp/should-not-be-used',
      {
        provider: 'codex',
        type: 'api-key',
        apiKey: 'sk-x',
        createdAt: new Date().toISOString(),
      },
      {
        refresher: async () => {
          throw new Error('should not be called');
        },
      },
    );
    expect(result?.type).toBe('api-key');
  });

  test('no-ops when oauth expiry is far in the future', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-refresh-'));
    const authFile = join(workspace, 'auth.json');
    const now = Date.UTC(2026, 0, 1);
    const cred = baseOauth(3600, now);
    let calls = 0;
    const result = await refreshCredentialIfNearExpiry(authFile, cred, {
      nowMs: now,
      skewMs: 60 * 1000,
      refresher: async () => {
        calls += 1;
        return cred;
      },
    });
    expect(calls).toBe(0);
    expect(result?.type).toBe('oauth');
    if (result?.type === 'oauth') {
      expect(result.accessToken).toBe('old-access');
    }
  });

  test('refreshes and persists when within skew', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-refresh-'));
    const authFile = join(workspace, 'auth.json');
    const now = Date.UTC(2026, 0, 1);
    const cred = baseOauth(30, now);
    await saveCredential(authFile, cred);

    let calls = 0;
    const refreshed = await refreshCredentialIfNearExpiry(authFile, cred, {
      nowMs: now,
      skewMs: 60 * 1000,
      refresher: async (current) => {
        calls += 1;
        expect(current.refreshToken).toBe('old-refresh');
        return {
          provider: 'codex',
          type: 'oauth',
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          accountId: current.accountId,
          createdAt: current.createdAt,
          expiresAt: new Date(now + 3600 * 1000).toISOString(),
        };
      },
    });

    expect(calls).toBe(1);
    expect(refreshed?.type).toBe('oauth');
    if (refreshed?.type === 'oauth') {
      expect(refreshed.accessToken).toBe('new-access');
    }
    const persisted = (await loadCredential(authFile)) as CredentialRecord & {
      type: 'oauth';
    };
    expect(persisted.accessToken).toBe('new-access');
    const onDisk = JSON.parse(await readFile(authFile, 'utf8')) as {
      credential: CredentialRecord & { type: 'oauth' };
    };
    expect(onDisk.credential.accessToken).toBe('new-access');
  });
});
