import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import type { CredentialRecord } from '@/types';

const CLIENT_ID =
  process.env.JUNO_OPENAI_CLIENT_ID ?? 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL =
  process.env.JUNO_OPENAI_AUTHORIZE_URL ??
  'https://auth.openai.com/oauth/authorize';
const TOKEN_URL =
  process.env.JUNO_OPENAI_TOKEN_URL ?? 'https://auth.openai.com/oauth/token';
const DEVICE_ACCOUNTS_URL =
  process.env.JUNO_OPENAI_DEVICE_ACCOUNTS_URL ??
  'https://auth.openai.com/api/accounts';

export const DEFAULT_OAUTH_PORT = 1455;

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

export function extractAccountIdFromJwt(
  jwt: string | undefined,
): string | undefined {
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

export type OAuthOperation =
  | 'token exchange'
  | 'token refresh'
  | 'device code request'
  | 'device code poll';

const NETWORK_ERROR_HINT =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|certificate|TLS|UND_ERR/i;

export function describeOAuthHttpError(
  operation: OAuthOperation,
  status: number,
  body: string,
): string {
  let errCode: string | undefined;
  let errDesc: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      error_description?: string;
    };
    errCode = parsed.error;
    errDesc = parsed.error_description;
  } catch {
    // body is not JSON; fall through and use the raw text
  }

  const detail =
    errDesc ??
    errCode ??
    (body.trim().length > 0 ? body.trim() : 'no response body');

  if (
    status === 400 &&
    (errCode === 'invalid_grant' || /invalid_grant|expired/i.test(detail))
  ) {
    return `OAuth ${operation} rejected: the OAuth code or refresh token is invalid or expired. Re-run \`juno login\`.`;
  }
  if (status === 400 && errCode === 'invalid_request') {
    return `OAuth ${operation} rejected: invalid request (${detail}).`;
  }
  if (status === 401 || status === 403) {
    return `OAuth ${operation} rejected by OpenAI auth (HTTP ${status}: ${detail}). Re-run \`juno login\`.`;
  }
  if (status === 429) {
    return `OAuth ${operation} rate-limited (HTTP 429: ${detail}). Try again in a moment.`;
  }
  if (status >= 500 && status <= 599) {
    return `OpenAI auth servers returned HTTP ${status} during ${operation} (${detail}). Try again in a moment.`;
  }
  return `OAuth ${operation} failed (HTTP ${status}: ${detail}).`;
}

export function describeOAuthFetchError(
  operation: OAuthOperation,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_ERROR_HINT.test(message)) {
    return `Could not reach OpenAI auth servers during ${operation} (${message}). Check your internet connection and retry.`;
  }
  return `OAuth ${operation} failed: ${message}`;
}

async function readBodySafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function exchangeForApiKey(idToken: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
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
  } catch {
    // Network failure during the id_token swap is non-fatal: the caller
    // falls back to the Codex backend with the access_token Bearer. Swallow
    // here so a flaky DNS lookup at login time doesn't abort the whole flow.
    return undefined;
  }

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
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
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
  } catch (error) {
    throw new Error(describeOAuthFetchError('token exchange', error));
  }

  if (!response.ok) {
    throw new Error(
      describeOAuthHttpError(
        'token exchange',
        response.status,
        await readBodySafely(response),
      ),
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
    accountId:
      extractAccountIdFromJwt(payload.id_token) ??
      extractAccountIdFromJwt(payload.access_token),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Parses the OAuth callback the user can paste back into the terminal when
 * the localhost redirect doesn't work (firewalled, remote dev, etc.).
 *
 * Accepts:
 *   - a full URL: `http://localhost:1455/auth/callback?code=…&state=…`
 *   - a bare query string: `code=…&state=…` (with or without leading `?`)
 *
 * Throws on missing code or state mismatch.
 */
export function parseOAuthCallback(
  input: string,
  expectedState: string,
): { code: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('empty OAuth callback input');
  }

  let params: URLSearchParams;
  try {
    const url = new URL(trimmed);
    params = url.searchParams;
  } catch {
    const qs = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    params = new URLSearchParams(qs);
  }

  const code = params.get('code');
  const state = params.get('state');

  if (!code) {
    throw new Error('OAuth callback is missing the `code` parameter');
  }
  if (state !== expectedState) {
    throw new Error('OAuth state mismatch');
  }
  return { code };
}

export type LoginWithBrowserOptions = {
  port?: number;
  stdin?: NodeJS.ReadableStream;
};

export async function loginWithBrowser(
  options: LoginWithBrowserOptions = {},
): Promise<{
  url: string;
  redirectUri: string;
  credential: Promise<CredentialRecord>;
}> {
  const port = options.port ?? DEFAULT_OAUTH_PORT;
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
      let settled = false;
      const stdin = (options.stdin ??
        process.stdin) as unknown as NodeJS.EventEmitter;
      let stdinBuffer = '';

      const cleanup = () => {
        try {
          server.close();
        } catch {
          // ignore
        }
        try {
          stdin.off('data', onStdinData);
        } catch {
          // ignore
        }
      };

      const settleResolve = (record: CredentialRecord) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(record);
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(err);
      };

      const onStdinData = (chunk: Buffer | string) => {
        if (settled) return;
        stdinBuffer +=
          typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let newlineIndex = stdinBuffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = stdinBuffer.slice(0, newlineIndex);
          stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
          const candidate = line.trim();
          if (candidate.length > 0) {
            try {
              const { code } = parseOAuthCallback(candidate, state);
              void exchangeCode(code, redirectUri, verifier).then(
                settleResolve,
                settleReject,
              );
              return;
            } catch (err) {
              // Don't reject; let the user paste again or wait for the server.
              process.stderr.write(
                `[juno] ignoring pasted line: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          }
          newlineIndex = stdinBuffer.indexOf('\n');
        }
      };

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
          response.end(
            'Invalid OAuth callback. You can paste the callback URL into the terminal instead.',
          );
          return;
        }

        response.end('Login complete. You can close this tab.');
        void exchangeCode(code, redirectUri, verifier).then(
          settleResolve,
          settleReject,
        );
      });

      server.on('error', (err) => {
        process.stderr.write(
          `[juno] OAuth callback server failed on port ${port}: ${err.message}\n` +
            '       You can still complete login by pasting the callback URL into the terminal.\n',
        );
      });

      server.listen(port, '127.0.0.1');

      try {
        stdin.on('data', onStdinData);
      } catch (err) {
        process.stderr.write(
          `[juno] stdin paste fallback unavailable: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    },
  );

  return { url: authUrl.toString(), redirectUri, credential };
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
  let response: Response;
  try {
    response = await fetch(`${DEVICE_ACCOUNTS_URL}/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
  } catch (error) {
    throw new Error(describeOAuthFetchError('device code request', error));
  }

  if (!response.ok) {
    throw new Error(
      describeOAuthHttpError(
        'device code request',
        response.status,
        await readBodySafely(response),
      ),
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
    let response: Response;
    try {
      response = await fetch(`${DEVICE_ACCOUNTS_URL}/deviceauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: deviceCode.deviceAuthId,
          user_code: deviceCode.userCode,
        }),
      });
    } catch (error) {
      throw new Error(describeOAuthFetchError('device code poll', error));
    }

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
      describeOAuthHttpError(
        'device code poll',
        response.status,
        await readBodySafely(response),
      ),
    );
  }
}

export async function refreshOAuthCredential(
  current: CredentialRecord & { type: 'oauth' },
): Promise<CredentialRecord> {
  if (!current.refreshToken) {
    throw new Error(
      'OAuth credential has no refresh token; re-run `juno login`',
    );
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch (error) {
    throw new Error(describeOAuthFetchError('token refresh', error));
  }

  if (!response.ok) {
    throw new Error(
      describeOAuthHttpError(
        'token refresh',
        response.status,
        await readBodySafely(response),
      ),
    );
  }

  const payload = (await response.json()) as TokenPayload;
  if (!payload.access_token) {
    throw new Error('OAuth token refresh returned no access_token');
  }

  return {
    provider: 'codex',
    type: 'oauth',
    apiKey: current.apiKey,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? current.refreshToken,
    expiresAt: payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : undefined,
    accountId:
      extractAccountIdFromJwt(payload.id_token) ??
      extractAccountIdFromJwt(payload.access_token) ??
      current.accountId,
    createdAt: current.createdAt,
  };
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
