import { describe, expect, test } from 'bun:test';

import { describeOAuthFetchError, describeOAuthHttpError } from '@/auth/codex';

describe('describeOAuthHttpError', () => {
  test('400 invalid_grant tells the user to re-run login', () => {
    const message = describeOAuthHttpError(
      'token refresh',
      400,
      JSON.stringify({
        error: 'invalid_grant',
        error_description: 'The refresh token is invalid.',
      }),
    );
    expect(message).toContain('invalid or expired');
    expect(message).toContain('juno login');
  });

  test('400 invalid_grant detected from description even when error code is generic', () => {
    const message = describeOAuthHttpError(
      'token refresh',
      400,
      JSON.stringify({
        error: 'invalid_request',
        error_description: 'authorization code expired',
      }),
    );
    expect(message).toContain('invalid or expired');
  });

  test('401 surfaces a re-login hint', () => {
    const message = describeOAuthHttpError(
      'token refresh',
      401,
      JSON.stringify({ error: 'invalid_token' }),
    );
    expect(message).toContain('HTTP 401');
    expect(message).toContain('juno login');
  });

  test('429 surfaces a retry hint, not a re-login hint', () => {
    const message = describeOAuthHttpError(
      'token exchange',
      429,
      JSON.stringify({ error: 'rate_limited' }),
    );
    expect(message).toContain('rate-limited');
    expect(message).not.toContain('juno login');
  });

  test('503 surfaces a retry hint and the upstream status', () => {
    const message = describeOAuthHttpError('token exchange', 503, 'oops');
    expect(message).toContain('HTTP 503');
    expect(message).toContain('Try again');
  });

  test('unrecognized status falls back to a generic HTTP message', () => {
    const message = describeOAuthHttpError('token exchange', 418, 'teapot');
    expect(message).toContain('HTTP 418');
    expect(message).toContain('teapot');
  });

  test('non-JSON body is preserved verbatim', () => {
    const message = describeOAuthHttpError(
      'token exchange',
      400,
      'rate limit reached for unknown reason',
    );
    expect(message).toContain('rate limit reached for unknown reason');
  });

  test('empty body is rendered as `no response body`', () => {
    const message = describeOAuthHttpError('token refresh', 500, '');
    expect(message).toContain('no response body');
  });

  test('operation appears in every message', () => {
    expect(describeOAuthHttpError('device code poll', 400, '')).toContain(
      'device code poll',
    );
    expect(describeOAuthHttpError('device code request', 503, '')).toContain(
      'device code request',
    );
  });
});

describe('describeOAuthFetchError', () => {
  test('network error gets a connectivity hint', () => {
    const message = describeOAuthFetchError(
      'token refresh',
      new TypeError('fetch failed'),
    );
    expect(message).toContain('Could not reach OpenAI');
    expect(message).toContain('Check your internet');
  });

  test('ENOTFOUND maps to the connectivity hint', () => {
    const message = describeOAuthFetchError(
      'token exchange',
      new Error('getaddrinfo ENOTFOUND auth.openai.com'),
    );
    expect(message).toContain('Could not reach OpenAI');
  });

  test('TLS / certificate errors map to the connectivity hint', () => {
    const message = describeOAuthFetchError(
      'token refresh',
      new Error('unable to verify the first certificate'),
    );
    expect(message).toContain('Could not reach OpenAI');
  });

  test('non-network errors fall through with the raw message', () => {
    const message = describeOAuthFetchError(
      'token exchange',
      new Error('something else broke'),
    );
    expect(message).toContain('something else broke');
    expect(message).not.toContain('Could not reach OpenAI');
  });
});
