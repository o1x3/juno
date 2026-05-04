import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadCredential,
  resolveCredential,
  saveCredential,
} from '@/auth/storage';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('auth storage', () => {
  test('persists credentials with restrictive permissions', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'nexus-auth-'));
    const authFile = join(workspace, 'auth.json');
    await saveCredential(authFile, {
      provider: 'codex',
      type: 'api-key',
      apiKey: 'test-key',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(await loadCredential(authFile)).toEqual({
      provider: 'codex',
      type: 'api-key',
      apiKey: 'test-key',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect((await stat(authFile)).mode & 0o777).toBe(0o600);
  });

  test('prefers env api key over stored credentials', () => {
    expect(
      resolveCredential('env-key', {
        provider: 'codex',
        type: 'api-key',
        apiKey: 'stored-key',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({ apiKey: 'env-key' });
  });
});
