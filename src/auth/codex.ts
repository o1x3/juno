import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import type { CredentialRecord } from '@/types';

const CLIENT_ID =
  process.env.NEXUS_AGENT_OPENAI_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL =
  process.env.NEXUS_AGENT_OPENAI_AUTHORIZE_URL ??
  'https://auth.openai.com/oauth/authorize';
const TOKEN_URL =
  process.env.NEXUS_AGENT_OPENAI_TOKEN_URL ??
  'https://auth.openai.com/oauth/token';
const DEVICE_ACCOUNTS_URL =
  process.env.NEXUS_AGENT_OPENAI_DEVICE_ACCOUNTS_URL ??
  'https://auth.openai.com/api/accounts';

function base64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

type TokenPayload = {
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

function readAccountIdFromJwt(jwt: string | undefined): string | undefined {
  if (!jwt) {
    return undefined;
  }

  try {
    const payload = jwt.split('.')[1];
    if (!payload) {
      return undefined;
    }
    const json = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as {
      'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
    };
    return json['https://api.openai.com/auth']?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

async function exchangeForApiKey(idToken: string): Promise<string | undefined> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CLIENT_ID,
      requested_token: 'openai-api-key',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    }),
  });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as { access_token?: string };
  return payload.access_token;
}

async function exchangeCode(
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<CredentialRecord> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as TokenPayload;
  const apiKey = await exchangeForApiKey(payload.id_token ?? '');

  return {
    provider: 'codex',
    type: 'oauth',
    apiKey,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : undefined,
    accountId: readAccountIdFromJwt(payload.id_token),
    createdAt: new Date().toISOString(),
  };
}

export async function loginWithBrowser(
  port = 1455,
): Promise<{ url: string; credential: Promise<CredentialRecord> }> {
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(18));
  const redirectUri = `http://localhost:${port}/auth/callback`;

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email offline_access');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

  const credential = new Promise<CredentialRecord>(
    (resolvePromise, rejectPromise) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/auth/callback') {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }

        const returnedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (returnedState !== state || !code) {
          response.statusCode = 400;
          response.end('Invalid OAuth callback');
          server.close();
          rejectPromise(new Error('Invalid OAuth callback'));
          return;
        }

        response.end('Login complete. You can close this tab.');
        server.close();
        void exchangeCode(code, redirectUri, verifier).then(
          resolvePromise,
          rejectPromise,
        );
      });

      server.listen(port, '127.0.0.1');
    },
  );

  return { url: authUrl.toString(), credential };
}

export function createApiKeyCredential(apiKey: string): CredentialRecord {
  return {
    provider: 'codex',
    type: 'api-key',
    apiKey,
    createdAt: new Date().toISOString(),
  };
}

type DeviceCode = {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  interval: number;
};

async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await fetch(`${DEVICE_ACCOUNTS_URL}/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    throw new Error(
      `Device code request failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as {
    device_auth_id: string;
    user_code: string;
    interval?: string;
  };

  return {
    verificationUrl: `${new URL(DEVICE_ACCOUNTS_URL).origin}/codex/device`,
    userCode: payload.user_code,
    deviceAuthId: payload.device_auth_id,
    interval: Number.parseInt(payload.interval ?? '5', 10),
  };
}

async function pollDeviceCode(
  deviceCode: DeviceCode,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  while (true) {
    const response = await fetch(`${DEVICE_ACCOUNTS_URL}/deviceauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
    });

    if (response.ok) {
      const payload = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      return {
        authorizationCode: payload.authorization_code,
        codeVerifier: payload.code_verifier,
      };
    }

    if (response.status === 403 || response.status === 404) {
      await Bun.sleep(deviceCode.interval * 1000);
      continue;
    }

    throw new Error(
      `Device auth failed: ${response.status} ${await response.text()}`,
    );
  }
}

export async function loginWithDeviceCode(): Promise<{
  verificationUrl: string;
  userCode: string;
  credential: Promise<CredentialRecord>;
}> {
  const deviceCode = await requestDeviceCode();
  return {
    verificationUrl: deviceCode.verificationUrl,
    userCode: deviceCode.userCode,
    credential: (async () => {
      const authCode = await pollDeviceCode(deviceCode);
      return exchangeCode(
        authCode.authorizationCode,
        `${new URL(DEVICE_ACCOUNTS_URL).origin}/deviceauth/callback`,
        authCode.codeVerifier,
      );
    })(),
  };
}
