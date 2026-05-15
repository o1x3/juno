export const EXA_DEFAULT_ENDPOINT = 'https://api.exa.ai/search';
export const EXA_DEFAULT_TIMEOUT_MS = 20_000;

export type ExaSearchOptions = {
  numResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  endpoint?: string;
  timeoutMs?: number;
  type?: 'auto' | 'neural' | 'keyword';
};

export type ExaSearchDeps = {
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export type WebSearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
};

export type WebSearchOutcome = {
  query: string;
  results: WebSearchResultItem[];
};

export type WebSearchErrorKind =
  | 'auth'
  | 'rate-limited'
  | 'http-error'
  | 'network'
  | 'timeout'
  | 'malformed-response';

export class WebSearchFailure extends Error {
  readonly kind: WebSearchErrorKind;
  readonly status?: number;

  constructor(kind: WebSearchErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

type RawExaResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    text?: string;
    score?: number;
    publishedDate?: string;
    summary?: string;
  }>;
};

function snippetFromText(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 600);
}

export async function searchWithExa(
  query: string,
  deps: ExaSearchDeps,
  options: ExaSearchOptions = {},
): Promise<WebSearchOutcome> {
  if (!deps.apiKey) {
    throw new WebSearchFailure(
      'auth',
      'EXA_API_KEY is not set. Get a key at https://exa.ai/ and export EXA_API_KEY=…',
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? EXA_DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? EXA_DEFAULT_TIMEOUT_MS;
  const body = {
    query,
    numResults: options.numResults ?? 8,
    type: options.type ?? 'auto',
    contents: { text: { maxCharacters: 1500 } },
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': deps.apiKey,
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new WebSearchFailure(
        'timeout',
        `Exa request timed out after ${timeoutMs}ms`,
      );
    }
    throw new WebSearchFailure(
      'network',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new WebSearchFailure(
      'auth',
      'Exa rejected the API key. Check EXA_API_KEY.',
      response.status,
    );
  }
  if (response.status === 429) {
    throw new WebSearchFailure(
      'rate-limited',
      'Exa rate limit hit (HTTP 429). Try again later.',
      429,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new WebSearchFailure(
      'http-error',
      `Exa HTTP ${response.status}: ${text.slice(0, 200)}`.trim(),
      response.status,
    );
  }

  let raw: RawExaResponse;
  try {
    raw = (await response.json()) as RawExaResponse;
  } catch (error) {
    throw new WebSearchFailure(
      'malformed-response',
      `Exa returned non-JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const rawResults = Array.isArray(raw.results) ? raw.results : [];
  const results: WebSearchResultItem[] = rawResults
    .map((item) => {
      const title = typeof item.title === 'string' ? item.title : '';
      const url = typeof item.url === 'string' ? item.url : '';
      const snippet = snippetFromText(item.summary ?? item.text);
      const entry: WebSearchResultItem = {
        title,
        url,
        snippet,
      };
      if (typeof item.score === 'number') entry.score = item.score;
      if (typeof item.publishedDate === 'string') {
        entry.publishedDate = item.publishedDate;
      }
      return entry;
    })
    .filter((entry) => entry.url.length > 0);

  return { query, results };
}
