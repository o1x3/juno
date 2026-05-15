import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

export function resolveModelsDevUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.JUNO_MODELS_DEV_URL?.trim();
  return override && override.length > 0 ? override : DEFAULT_MODELS_DEV_URL;
}

// Models known to be accepted by the ChatGPT-account Codex backend.
// Sourced from ref/opencode/packages/opencode/src/plugin/codex.ts and the
// upstream Codex CLI bundled catalog (ref/codex/codex-rs/models-manager/models.json).
// Older slugs like gpt-5.1-codex-mini are intentionally excluded — the backend
// returns 400 "not supported when using Codex with a ChatGPT account" for them.
export const CHATGPT_ACCOUNT_SAFE_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
]);

// Strict allowlist check. The original draft of this had a `gpt-X.Y > 5.4`
// future-proof regex (lifted from opencode), but that is the same shape of bug
// we are fixing here — auto-routing a slug that has not actually been
// confirmed against the ChatGPT-account backend. When upstream ships a new
// model, refresh CHATGPT_ACCOUNT_SAFE_MODELS deliberately.
export function isChatGptAccountSafeModel(id: string): boolean {
  return CHATGPT_ACCOUNT_SAFE_MODELS.has(id);
}

const STATIC_FALLBACK: CodexModel[] = [
  {
    id: 'gpt-5.4-mini',
    inputCost: 0.75,
    outputCost: 4.5,
    cacheReadCost: 0.075,
    reasoning: true,
    contextLimit: 272000,
  },
  {
    id: 'gpt-5.3-codex',
    inputCost: 1.75,
    outputCost: 14,
    cacheReadCost: 0.175,
    reasoning: true,
    contextLimit: 272000,
  },
  {
    id: 'gpt-5.4',
    inputCost: 2.5,
    outputCost: 15,
    cacheReadCost: 0.25,
    reasoning: true,
    contextLimit: 272000,
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
  return fetch(resolveModelsDevUrl(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

let processCache: Promise<CodexRegistry> | undefined;

export function resetCodexRegistryCache(): void {
  processCache = undefined;
}

/**
 * Force a fresh fetch from models.dev (honoring `JUNO_MODELS_DEV_URL`).
 * Clears both the in-process memo and the on-disk cache, then delegates to
 * `discoverCodexModels`. Returns the fresh registry, falling back to cache /
 * static the same way the regular discovery does on network failure.
 */
export async function refreshCodexRegistry(
  options: DiscoverOptions,
): Promise<CodexRegistry> {
  resetCodexRegistryCache();
  await rm(cacheFile(options.homeDir), { force: true });
  return discoverCodexModels(options);
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

// Picker for OAuth credentials that route through the ChatGPT-account Codex
// backend. Filters the registry down to models the backend actually accepts;
// honors an explicit override verbatim so a user-pinned slug surfaces a clear
// backend error rather than getting silently rewritten.
export function pickCodexModelForChatGptAccount(
  configuredModel: string,
  override: string | undefined,
  registry: CodexRegistry,
): CodexModelChoice {
  if (override && override.trim().length > 0) {
    return { model: override, source: registry.source };
  }

  const safeModels = registry.models.filter((model) =>
    isChatGptAccountSafeModel(model.id),
  );

  if (
    isChatGptAccountSafeModel(configuredModel) &&
    isCodexModel(configuredModel, safeModels)
  ) {
    return { model: configuredModel, source: registry.source };
  }

  if (safeModels.length === 0) {
    return {
      model: 'gpt-5.4-mini',
      fallbackFrom: configuredModel,
      source: registry.source,
    };
  }

  return {
    model: pickDefaultCodexModel(safeModels),
    fallbackFrom: configuredModel,
    source: registry.source,
  };
}
