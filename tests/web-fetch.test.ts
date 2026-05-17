import { describe, expect, test } from 'bun:test';

import {
  fetchWithLimits,
  formatBody,
  htmlToMarkdown,
  htmlToText,
  isBinaryContentType,
  upgradeHttpToHttps,
  validateUrl,
  WebFetchFailure,
} from '@/core/web-fetch';

describe('web-fetch helpers', () => {
  test('upgradeHttpToHttps swaps the scheme', () => {
    expect(upgradeHttpToHttps('http://example.com/x').url).toBe(
      'https://example.com/x',
    );
    expect(upgradeHttpToHttps('http://example.com/x').upgraded).toBe(true);
    expect(upgradeHttpToHttps('https://example.com').upgraded).toBe(false);
    expect(upgradeHttpToHttps('https://example.com').url).toBe(
      'https://example.com',
    );
  });

  test('validateUrl accepts http/https only', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow();
    expect(() => validateUrl('http://example.com')).not.toThrow();
    expect(() => validateUrl('file:///etc/passwd')).toThrow(WebFetchFailure);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(WebFetchFailure);
    expect(() => validateUrl('not a url')).toThrow(WebFetchFailure);
  });

  test('isBinaryContentType detects common binary types', () => {
    expect(isBinaryContentType('image/png')).toBe(true);
    expect(isBinaryContentType('application/pdf; charset=binary')).toBe(true);
    expect(isBinaryContentType('text/html; charset=utf-8')).toBe(false);
    expect(isBinaryContentType('application/json')).toBe(false);
    expect(isBinaryContentType('')).toBe(false);
  });

  test('htmlToMarkdown strips scripts and converts headings', () => {
    const md = htmlToMarkdown(
      '<script>bad()</script><h1>Title</h1><p>hello <b>world</b></p>',
    );
    expect(md).not.toContain('bad()');
    expect(md).toContain('# Title');
    expect(md.toLowerCase()).toContain('hello');
    expect(md.toLowerCase()).toContain('world');
  });

  test('htmlToText strips tags and entities', () => {
    const text = htmlToText('<p>hello&nbsp;world</p><style>x{}</style>');
    expect(text).toContain('hello world');
    expect(text).not.toContain('<p>');
    expect(text).not.toContain('x{}');
  });

  test('formatBody preserves non-html bodies', () => {
    const { body, format } = formatBody(
      '{"ok":true}',
      'application/json',
      'markdown',
    );
    expect(body).toBe('{"ok":true}');
    expect(format).toBe('text');
  });

  test('formatBody renders html as markdown by default', () => {
    const { body, format } = formatBody(
      '<h1>X</h1>',
      'text/html; charset=utf-8',
      'markdown',
    );
    expect(format).toBe('markdown');
    expect(body).toContain('# X');
  });
});

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    ...((init.headers as Record<string, string>) ?? {}),
  });
  return new Response(body, { ...init, headers });
}

describe('fetchWithLimits', () => {
  test('returns parsed body for a successful html response', async () => {
    const fetchImpl = async () =>
      htmlResponse('<h1>Hi</h1><p>body</p>', { status: 200 });
    const result = await fetchWithLimits('https://example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toContain('text/html');
    expect(result.body).toContain('<h1>Hi</h1>');
    expect(result.upgraded).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test('reports upgraded:true when called with http://', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return htmlResponse('<p>ok</p>');
    };
    const result = await fetchWithLimits('http://example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen[0]).toBe('https://example.com');
    expect(result.upgraded).toBe(true);
  });

  test('throws WebFetchFailure on non-2xx', async () => {
    const fetchImpl = async () =>
      new Response('not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    try {
      await fetchWithLimits('https://example.com/missing', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchFailure);
      expect((error as WebFetchFailure).kind).toBe('http-error');
      expect((error as WebFetchFailure).status).toBe(404);
    }
  });

  test('refuses binary content-types without buffering the body', async () => {
    const fetchImpl = async () =>
      new Response('PDFDATA', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    try {
      await fetchWithLimits('https://example.com/file.pdf', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchFailure);
      expect((error as WebFetchFailure).kind).toBe('binary');
    }
  });

  test('truncates oversized bodies', async () => {
    const big = 'a'.repeat(1024);
    const fetchImpl = async () => htmlResponse(big, { status: 200 });
    const result = await fetchWithLimits('https://example.com', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(100);
    expect(result.body.length).toBeLessThanOrEqual(100);
  });

  test('surfaces a timeout', async () => {
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    try {
      await fetchWithLimits('https://example.com', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 25,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchFailure);
      expect((error as WebFetchFailure).kind).toBe('timeout');
    }
  });

  test('rejects unsupported schemes', async () => {
    const fetchImpl = async () => htmlResponse('ignored');
    try {
      await fetchWithLimits('file:///etc/hosts', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WebFetchFailure);
      expect((error as WebFetchFailure).kind).toBe('unsupported-scheme');
    }
  });
});
