import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { refreshOAuthCredential } from '@/auth/codex';
import type { CredentialRecord } from '@/types';

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

type AuthFile = {
  provider: 'codex';
  credential: CredentialRecord;
};

export async function saveCredential(
  authFile: string,
  credential: CredentialRecord,
): Promise<void> {
  await mkdir(dirname(authFile), { recursive: true });
  await Bun.write(
    authFile,
    `${JSON.stringify({ provider: 'codex', credential }, null, 2)}\n`,
  );
  await chmod(authFile, 0o600);
}

export async function loadCredential(
  authFile: string,
): Promise<CredentialRecord | undefined> {
  try {
    const payload = JSON.parse(await readFile(authFile, 'utf8')) as AuthFile;
    return payload.credential;
  } catch {
    return undefined;
  }
}

export async function clearCredential(authFile: string): Promise<void> {
  await rm(authFile, { force: true });
}

export function resolveCredential(
  envApiKey: string | undefined,
  stored: CredentialRecord | undefined,
): CredentialRecord | undefined {
  if (envApiKey) {
    return {
      provider: 'codex',
      type: 'api-key',
      apiKey: envApiKey,
      createdAt: new Date().toISOString(),
    };
  }

  return stored;
}

export type RefreshOptions = {
  nowMs?: number;
  skewMs?: number;
  refresher?: typeof refreshOAuthCredential;
  persist?: typeof saveCredential;
};

export async function refreshCredentialIfNearExpiry(
  authFile: string,
  credential: CredentialRecord | undefined,
  options: RefreshOptions = {},
): Promise<CredentialRecord | undefined> {
  if (!credential || credential.type !== 'oauth') {
    return credential;
  }
  if (!credential.expiresAt || !credential.refreshToken) {
    return credential;
  }

  const now = options.nowMs ?? Date.now();
  const skew = options.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const expiresAtMs = Date.parse(credential.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs - now > skew) {
    return credential;
  }

  const refresh = options.refresher ?? refreshOAuthCredential;
  const persist = options.persist ?? saveCredential;
  const refreshed = await refresh(credential);
  await persist(authFile, refreshed);
  return refreshed;
}
