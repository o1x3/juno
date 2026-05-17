import TurndownService from 'turndown';

export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const BINARY_PREFIXES = [
  'image/',
  'audio/',
  'video/',
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/x-gzip',
  'application/x-tar',
];

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export type WebFetchFormat = 'markdown' | 'text' | 'html';

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  format: WebFetchFormat;
  body: string;
  truncated: boolean;
  upgraded: boolean;
  bytes: number;
};

export type WebFetchError = {
  kind:
    | 'invalid-url'
    | 'unsupported-scheme'
    | 'timeout'
    | 'network'
    | 'http-error'
    | 'binary'
    | 'too-large';
  message: string;
  status?: number;
};

export class WebFetchFailure extends Error {
  readonly kind: WebFetchError['kind'];
  readonly status?: number;

  constructor(error: WebFetchError) {
    super(error.message);
    this.kind = error.kind;
    this.status = error.status;
  }
}

export function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ct) return false;
  return BINARY_PREFIXES.some((prefix) => ct.startsWith(prefix));
}

export function upgradeHttpToHttps(url: string): {
  url: string;
  upgraded: boolean;
} {
  if (url.startsWith('http://')) {
    return { url: `https://${url.slice('http://'.length)}`, upgraded: true };
  }
  return { url, upgraded: false };
}

export function validateUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebFetchFailure({
      kind: 'invalid-url',
      message: `Invalid URL: ${raw}`,
    });
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new WebFetchFailure({
      kind: 'unsupported-scheme',
      message: `Refusing to fetch ${parsed.protocol}// URLs (only http/https supported)`,
    });
  }
  return parsed;
}

function stripDangerousBlocks(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

export function htmlToMarkdown(html: string): string {
  const cleaned = stripDangerousBlocks(html);
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // Turndown ignores tables by default; keep them as-is for downstream LLMs.
  service.keep(['table']);
  return service.turndown(cleaned).trim();
}

export function htmlToText(html: string): string {
  return stripDangerousBlocks(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type FetchDeps = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

export async function fetchWithLimits(
  rawUrl: string,
  deps: FetchDeps = {},
): Promise<{
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
  upgraded: boolean;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? WEB_FETCH_MAX_BYTES;

  // Validate before any upgrade so invalid-scheme errors surface as themselves.
  validateUrl(rawUrl);
  const { url: target, upgraded } = upgradeHttpToHttps(rawUrl);
  validateUrl(target);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'juno-webfetch/0.1' },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new WebFetchFailure({
        kind: 'timeout',
        message: `Fetch timed out after ${timeoutMs}ms: ${target}`,
      });
    }
    throw new WebFetchFailure({
      kind: 'network',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (isBinaryContentType(contentType)) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new WebFetchFailure({
      kind: 'binary',
      message: `Refusing to fetch binary content-type: ${contentType || 'unknown'}`,
      status: response.status,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new WebFetchFailure({
      kind: 'http-error',
      message:
        `HTTP ${response.status} ${response.statusText || ''}: ${body.slice(0, 200)}`.trim(),
      status: response.status,
    });
  }

  const finalUrl = response.url || target;

  if (!response.body) {
    return {
      status: response.status,
      finalUrl,
      contentType,
      body: '',
      bytes: 0,
      truncated: false,
      upgraded,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let collected = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        const overshoot = bytes - maxBytes;
        if (overshoot < value.byteLength) {
          collected += decoder.decode(
            value.slice(0, value.byteLength - overshoot),
            { stream: false },
          );
        }
        bytes = maxBytes;
        break;
      }
      collected += decoder.decode(value, { stream: true });
    }
    collected += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    if (truncated) {
      try {
        await response.body.cancel();
      } catch {
        // ignore
      }
    }
  }

  return {
    status: response.status,
    finalUrl,
    contentType,
    body: collected,
    bytes,
    truncated,
    upgraded,
  };
}

export function formatBody(
  rawBody: string,
  contentType: string,
  format: WebFetchFormat,
): { body: string; format: WebFetchFormat } {
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const isHtml = ct === 'text/html' || ct === 'application/xhtml+xml';
  if (!isHtml) {
    return { body: rawBody, format: format === 'html' ? 'html' : 'text' };
  }
  if (format === 'html') return { body: rawBody, format: 'html' };
  if (format === 'text') return { body: htmlToText(rawBody), format: 'text' };
  return { body: htmlToMarkdown(rawBody), format: 'markdown' };
}
