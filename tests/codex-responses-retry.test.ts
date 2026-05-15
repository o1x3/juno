import { describe, expect, test } from 'bun:test';

import {
  createCodexResponsesClient,
  fetchCodexWithRetry,
  isRetryableStatus,
  parseRetryAfter,
} from '@/core/codex-responses-client';

const FAKE_JWT = (() => {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
})();

function sseCompleted(): Response {
  const body = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed' },
  })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('parseRetryAfter', () => {
  test('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  test('parses fractional seconds', () => {
    expect(parseRetryAfter('1.5')).toBe(1500);
  });

  test('parses an HTTP date relative to now', () => {
    const now = Date.parse('2026-05-14T12:00:00.000Z');
    const future = 'Thu, 14 May 2026 12:00:10 GMT';
    expect(parseRetryAfter(future, now)).toBe(10_000);
  });

  test('returns null for unparseable input', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  test('429 retries', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });
  test('500-599 retry', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });
  test('400/401/404 do not retry', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
  test('200 does not retry', () => {
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('fetchCodexWithRetry', () => {
  test('retries a 503 and returns the next success', async () => {
    const statuses = [503, 200];
    let calls = 0;
    const fakeFetch = (async () => {
      const status = statuses[calls++] ?? 200;
      return new Response('', { status });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const response = await fetchCodexWithRetry(
      fakeFetch,
      'http://x',
      {},
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBe(500); // base delay, zero jitter
  });

  test('honors Retry-After on 429', async () => {
    const responses = [
      new Response('', {
        status: 429,
        headers: { 'retry-after': '2' },
      }),
      new Response('', { status: 200 }),
    ];
    let calls = 0;
    const fakeFetch = (async () =>
      responses[calls++] ??
      new Response('', { status: 200 })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const response = await fetchCodexWithRetry(
      fakeFetch,
      'http://x',
      {},
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    );
    expect(response.status).toBe(200);
    expect(sleeps[0]).toBe(2000);
  });

  test('does not retry a 400', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('bad', { status: 400 });
    }) as unknown as typeof fetch;
    const response = await fetchCodexWithRetry(
      fakeFetch,
      'http://x',
      {},
      {
        sleep: async () => {},
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  test('gives up after maxAttempts retryable failures', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response('upstream blew up', { status: 503 });
    }) as unknown as typeof fetch;
    const response = await fetchCodexWithRetry(
      fakeFetch,
      'http://x',
      {},
      {
        sleep: async () => {},
        retry: { maxAttempts: 3 },
      },
    );
    expect(response.status).toBe(503);
    expect(calls).toBe(3);
  });

  test('exponential backoff doubles base delay between attempts', async () => {
    const fakeFetch = (async () => {
      return new Response('', { status: 503 });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    await fetchCodexWithRetry(
      fakeFetch,
      'http://x',
      {},
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
        retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10_000 },
      },
    );
    expect(sleeps).toEqual([100, 200, 400]);
  });
});

describe('createCodexResponsesClient retry integration', () => {
  test('retries a 503 then streams a normal response', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('', { status: 503 });
      }
      return sseCompleted();
    }) as unknown as typeof fetch;

    const sleeps: number[] = [];
    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await client.runStep({
      model: 'gpt-5.4',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(calls).toBe(2);
    expect(sleeps.length).toBe(1);
    expect(result.finishReason).toBe('completed');
  });

  test('throws friendlyError after exhausting retries', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: 'server_error', message: 'boom' } }),
        { status: 503 },
      );
    }) as unknown as typeof fetch;

    const client = createCodexResponsesClient({
      baseUrl: 'https://chatgpt.com/backend-api',
      accessToken: FAKE_JWT,
      accountId: 'acct-1',
      fetchImpl: fakeFetch,
      sleepImpl: async () => {},
      retry: { maxAttempts: 2 },
    });

    await expect(
      client.runStep({
        model: 'gpt-5.4',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      }),
    ).rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });
});
