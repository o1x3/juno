import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type CodexModel = {
  id: string;
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  reasoning: boolean;
  contextLimit: number;
};

export type CodexRegistry = {
  models: CodexModel[];
  source: 'fresh' | 'cache' | 'static';
};

export type CodexModelChoice = {
  model: string;
  fallbackFrom?: string;
  source: CodexRegistry['source'];
};

const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

const STATIC_FALLBACK: CodexModel[] = [
  {
    id: 'gpt-5.1-codex-mini',
    inputCost: 0.25,
    outputCost: 2,
    cacheReadCost: 0.025,
    reasoning: true,
    contextLimit: 400000,
  },
  {
    id: 'gpt-5.1-codex',
    inputCost: 1.25,
    outputCost: 10,
    cacheReadCost: 0.125,
    reasoning: true,
    contextLimit: 400000,
  },
  {
    id: 'gpt-5.1-codex-max',
    inputCost: 1.25,
    outputCost: 10,
    cacheReadCost: 0.125,
    reasoning: true,
    contextLimit: 400000,
  },
  {
    id: 'gpt-5.2-codex',
    inputCost: 1.75,
    outputCost: 14,
    cacheReadCost: 0.175,
    reasoning: true,
    contextLimit: 400000,
  },
  {
    id: 'gpt-5.3-codex',
    inputCost: 1.75,
    outputCost: 14,
    cacheReadCost: 0.175,
    reasoning: true,
    contextLimit: 400000,
  },
];

type ModelsDevModel = {
  id?: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  cost?: { input?: number; output?: number; cache_read?: number };
  limit?: { context?: number };
};

type ModelsDevPayload = {
  openai?: { models?: Record<string, ModelsDevModel> };
};

function projectModelsDev(payload: ModelsDevPayload): CodexModel[] {
  const models = payload.openai?.models ?? {};
  const result: CodexModel[] = [];
  for (const entry of Object.values(models)) {
    if (
      !entry?.id ||
      entry.family !== 'gpt-codex' ||
      entry.tool_call !== true ||
      typeof entry.cost?.input !== 'number' ||
      typeof entry.cost?.output !== 'number'
    ) {
      continue;
    }
    result.push({
      id: entry.id,
      inputCost: entry.cost.input,
      outputCost: entry.cost.output,
      cacheReadCost: entry.cost.cache_read,
      reasoning: entry.reasoning === true,
      contextLimit: entry.limit?.context ?? 0,
    });
  }
  return result;
}

export type DiscoverOptions = {
  homeDir: string;
  ttlMs?: number;
  fetcher?: () => Promise<Response>;
  now?: () => number;
};

function cacheFile(homeDir: string): string {
  return join(homeDir, 'cache', 'codex-models.json');
}

async function readCache(
  path: string,
): Promise<{ fetchedAt: number; models: CodexModel[] } | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      fetchedAt?: number;
      models?: CodexModel[];
    };
    if (typeof parsed.fetchedAt !== 'number' || !Array.isArray(parsed.models)) {
      return undefined;
    }
    return { fetchedAt: parsed.fetchedAt, models: parsed.models };
  } catch {
    return undefined;
  }
}

async function writeCache(
  path: string,
  payload: { fetchedAt: number; models: CodexModel[] },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function defaultFetcher(): Promise<Response> {
  return fetch(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

let processCache: Promise<CodexRegistry> | undefined;

export function resetCodexRegistryCache(): void {
  processCache = undefined;
}

export async function discoverCodexModels(
  options: DiscoverOptions,
): Promise<CodexRegistry> {
  if (processCache) {
    return processCache;
  }

  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const path = cacheFile(options.homeDir);
  const fetcher = options.fetcher ?? defaultFetcher;

  processCache = (async (): Promise<CodexRegistry> => {
    const cached = await readCache(path);
    if (cached && now() - cached.fetchedAt < ttl) {
      return { models: cached.models, source: 'cache' };
    }

    try {
      const response = await fetcher();
      if (!response.ok) {
        throw new Error(`models.dev responded ${response.status}`);
      }
      const payload = (await response.json()) as ModelsDevPayload;
      const models = projectModelsDev(payload);
      if (models.length === 0) {
        throw new Error('models.dev returned no codex models');
      }
      await writeCache(path, { fetchedAt: now(), models });
      return { models, source: 'fresh' };
    } catch {
      if (cached) {
        return { models: cached.models, source: 'cache' };
      }
      return { models: STATIC_FALLBACK, source: 'static' };
    }
  })();

  return processCache;
}

export function pickDefaultCodexModel(models: CodexModel[]): string {
  const pool = models.length > 0 ? models : STATIC_FALLBACK;
  const sorted = [...pool].sort((a, b) => {
    const costA = a.inputCost + a.outputCost;
    const costB = b.inputCost + b.outputCost;
    if (costA !== costB) return costA - costB;
    return a.id.localeCompare(b.id);
  });
  return sorted[0]?.id ?? STATIC_FALLBACK[0]?.id ?? 'gpt-5.1-codex-mini';
}

export function isCodexModel(id: string, models: CodexModel[]): boolean {
  return models.some((model) => model.id === id);
}

export function pickCodexModel(
  configuredModel: string,
  override: string | undefined,
  registry: CodexRegistry,
): CodexModelChoice {
  if (override && override.trim().length > 0) {
    return { model: override, source: registry.source };
  }
  if (isCodexModel(configuredModel, registry.models)) {
    return { model: configuredModel, source: registry.source };
  }
  return {
    model: pickDefaultCodexModel(registry.models),
    fallbackFrom: configuredModel,
    source: registry.source,
  };
}
