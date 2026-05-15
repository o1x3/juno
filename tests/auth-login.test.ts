import { describe, expect, test } from 'bun:test';

import { parseOAuthCallback } from '@/auth/codex';
import { resolveOAuthPort } from '@/cli/index';

describe('resolveOAuthPort', () => {
  test('returns default 1455 when nothing is set', () => {
    expect(resolveOAuthPort(undefined, {})).toBe(1455);
  });

  test('CLI flag wins over env', () => {
    expect(resolveOAuthPort('5000', { JUNO_OAUTH_PORT: '4000' })).toBe(5000);
  });

  test('env applies when CLI flag is unset', () => {
    expect(resolveOAuthPort(undefined, { JUNO_OAUTH_PORT: '4000' })).toBe(4000);
  });

  test('rejects non-integer values', () => {
    expect(() => resolveOAuthPort('abc')).toThrow(/Invalid OAuth callback/);
  });

  test('rejects out-of-range ports', () => {
    expect(() => resolveOAuthPort('0')).toThrow(/Invalid OAuth callback/);
    expect(() => resolveOAuthPort('65536')).toThrow(/Invalid OAuth callback/);
  });

  test('accepts the boundary values', () => {
    expect(resolveOAuthPort('1')).toBe(1);
    expect(resolveOAuthPort('65535')).toBe(65535);
  });
});

describe('parseOAuthCallback', () => {
  const STATE = 'st4te-v4l';

  test('extracts code from a full callback URL', () => {
    expect(
      parseOAuthCallback(
        `http://localhost:1455/auth/callback?code=abc123&state=${STATE}`,
        STATE,
      ),
    ).toEqual({ code: 'abc123' });
  });

  test('extracts code from a bare query string', () => {
    expect(parseOAuthCallback(`code=abc123&state=${STATE}`, STATE)).toEqual({
      code: 'abc123',
    });
  });

  test('extracts code from a bare query string with leading ?', () => {
    expect(parseOAuthCallback(`?code=abc123&state=${STATE}`, STATE)).toEqual({
      code: 'abc123',
    });
  });

  test('trims surrounding whitespace', () => {
    expect(
      parseOAuthCallback(`   code=abc123&state=${STATE}   `, STATE),
    ).toEqual({
      code: 'abc123',
    });
  });

  test('rejects state mismatch', () => {
    expect(() => parseOAuthCallback(`code=abc&state=wrong`, STATE)).toThrow(
      /state mismatch/,
    );
  });

  test('rejects missing code', () => {
    expect(() => parseOAuthCallback(`state=${STATE}`, STATE)).toThrow(
      /missing the `code`/,
    );
  });

  test('rejects empty input', () => {
    expect(() => parseOAuthCallback('', STATE)).toThrow(/empty OAuth callback/);
  });
});
