import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CredentialRecord } from '@/types';

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
