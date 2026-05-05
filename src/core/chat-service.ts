import { createApiKeyCredential, extractAccountIdFromJwt } from '@/auth/codex';
import {
  DEFAULT_REFRESH_SKEW_MS,
  loadCredential,
  type RefreshOptions,
  refreshCredentialIfNearExpiry,
  resolveCredential,
} from '@/auth/storage';
import { runAgentTurn } from '@/core/agent-loop';
import {
  discoverCodexModels,
  pickCodexModelForChatGptAccount,
} from '@/core/codex-models';
import { createCodexResponsesClient } from '@/core/codex-responses-client';
import { loadProjectInstructions } from '@/core/instructions';
import { createAiSdkModelClient } from '@/core/model-client';
import { buildSystemPrompt } from '@/core/prompt';
import {
  appendSessionEvent,
  createSessionId,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';
import { createBuiltinTools } from '@/core/tools';
import type {
  AgentConfig,
  AgentTurnResult,
  AuthMode,
  AuthStatus,
  ModelClient,
  ModelFallback,
} from '@/types';

type ChatOptions = {
  config: AgentConfig;
  prompt: string;
  sessionId?: string;
  onTextDelta?: (delta: string) => void;
  onToolCall?: AgentTurnResult['toolCalls'][number] extends infer T
    ? (call: T) => void
    : never;
  onToolResult?: AgentTurnResult['toolResults'][number] extends infer T
    ? (result: T) => void
    : never;
};

type RoutingResolution = {
  runtimeConfig: AgentConfig;
  modelClient: ModelClient;
  authMode: AuthMode;
  activeModel: string;
  modelFallback?: ModelFallback;
};

async function resolveRouting(
  config: AgentConfig,
  refreshOptions?: RefreshOptions,
): Promise<RoutingResolution> {
  const stored = await loadCredential(config.authFile);
  let refreshed: typeof stored;
  try {
    refreshed = await refreshCredentialIfNearExpiry(
      config.authFile,
      stored,
      refreshOptions,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OAuth credential is near expiry and refresh failed: ${reason}. Re-run \`juno login\`.`,
    );
  }
  const credential = resolveCredential(config.apiKey, refreshed);

  if (credential?.type === 'api-key') {
    return {
      runtimeConfig: { ...config, apiKey: credential.apiKey },
      modelClient: createAiSdkModelClient({
        ...config,
        apiKey: credential.apiKey,
      }),
      authMode: 'api-key',
      activeModel: config.model,
    };
  }

  if (credential?.type === 'oauth' && credential.apiKey) {
    return {
      runtimeConfig: { ...config, apiKey: credential.apiKey },
      modelClient: createAiSdkModelClient({
        ...config,
        apiKey: credential.apiKey,
      }),
      authMode: 'oauth-api-key',
      activeModel: config.model,
    };
  }

  if (credential?.type === 'oauth') {
    const accountId =
      credential.accountId ?? extractAccountIdFromJwt(credential.accessToken);
    if (!accountId) {
      throw new Error(
        'Stored OAuth credential is missing a ChatGPT account id and the access_token JWT did not contain one. Re-run `juno login`.',
      );
    }
    const registry = await discoverCodexModels({ homeDir: config.homeDir });
    const choice = pickCodexModelForChatGptAccount(
      config.model,
      config.codexModelOverride,
      registry,
    );
    const runtimeConfig: AgentConfig = {
      ...config,
      apiKey: undefined,
      model: choice.model,
    };
    const modelClient = createCodexResponsesClient({
      baseUrl: config.codexBackendUrl,
      accessToken: credential.accessToken,
      accountId,
    });
    return {
      runtimeConfig,
      modelClient,
      authMode: 'oauth-codex',
      activeModel: choice.model,
      modelFallback: choice.fallbackFrom
        ? { from: choice.fallbackFrom, to: choice.model, source: choice.source }
        : undefined,
    };
  }

  if (config.apiKey) {
    return {
      runtimeConfig: config,
      modelClient: createAiSdkModelClient(config),
      authMode: 'api-key',
      activeModel: config.model,
    };
  }

  throw new Error(
    'No credential available. Run `juno login` or set OPENAI_API_KEY.',
  );
}

export async function startOrResumeChat(
  options: ChatOptions,
): Promise<{ sessionId: string; result: AgentTurnResult }> {
  const config = options.config;
  const sessionId = options.sessionId ?? createSessionId();
  const events = options.sessionId
    ? await readSessionEvents(config.sessionsDir, sessionId)
    : [];
  const messages = restoreMessages(events);

  if (!options.sessionId) {
    await appendSessionEvent(config.sessionsDir, sessionId, {
      type: 'status_meta',
      timestamp: new Date().toISOString(),
      status: 'session_started',
      sessionId,
      cwd: config.cwd,
      model: config.model,
    });
  }

  const routing = await resolveRouting(config);

  const instructions = await loadProjectInstructions(config.cwd);
  const systemPrompt = buildSystemPrompt(instructions);
  const result = await runAgentTurn({
    config: routing.runtimeConfig,
    sessionId,
    systemPrompt,
    userInput: options.prompt,
    messages,
    tools: createBuiltinTools({
      cwd: routing.runtimeConfig.cwd,
      outputLimit: routing.runtimeConfig.toolOutputLimit,
      readLineLimit: routing.runtimeConfig.readLineLimit,
      bashTimeoutMs: routing.runtimeConfig.bashTimeoutMs,
    }),
    modelClient: routing.modelClient,
    onTextDelta: options.onTextDelta,
    onToolCall: options.onToolCall as never,
    onToolResult: options.onToolResult as never,
  });

  return {
    sessionId,
    result: {
      ...result,
      authMode: routing.authMode,
      activeModel: routing.activeModel,
      modelFallback: routing.modelFallback,
    },
  };
}

export async function resolveAuthSummary(
  config: AgentConfig,
  refreshOptions?: RefreshOptions,
): Promise<{
  authMode: AuthMode;
  activeModel: string;
  modelFallback?: ModelFallback;
}> {
  try {
    const routing = await resolveRouting(config, refreshOptions);
    return {
      authMode: routing.authMode,
      activeModel: routing.activeModel,
      modelFallback: routing.modelFallback,
    };
  } catch {
    return { authMode: 'none', activeModel: config.model };
  }
}

function partialAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed.length <= 4) {
    return `…${trimmed}`;
  }
  return `…${trimmed.slice(-4)}`;
}

export async function resolveAuthStatus(
  config: AgentConfig,
  refreshOptions?: RefreshOptions,
): Promise<AuthStatus> {
  // resolveAuthSummary -> resolveRouting -> refreshCredentialIfNearExpiry
  // can refresh and persist a new credential when the token is within the
  // skew window. Run it first, THEN load the credential, so account-id /
  // expiresAt / refreshDueSoon reflect the post-refresh state on disk
  // rather than the stale snapshot we read going in.
  const summary = await resolveAuthSummary(config, refreshOptions);
  const stored = await loadCredential(config.authFile);

  let source: AuthStatus['source'];
  if (config.apiKey) {
    source = 'env';
  } else if (stored) {
    source = 'stored';
  } else {
    source = 'none';
  }

  const credentialType = config.apiKey ? ('api-key' as const) : stored?.type;

  let accountId: string | undefined;
  if (stored?.type === 'oauth') {
    accountId = stored.accountId ?? extractAccountIdFromJwt(stored.accessToken);
  }

  let expiresAt: string | undefined;
  let expiresInSeconds: number | undefined;
  let refreshDueSoon: boolean | undefined;
  if (stored?.type === 'oauth' && stored.expiresAt) {
    expiresAt = stored.expiresAt;
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (!Number.isNaN(expiresAtMs)) {
      expiresInSeconds = Math.round((expiresAtMs - Date.now()) / 1000);
      refreshDueSoon = expiresAtMs - Date.now() <= DEFAULT_REFRESH_SKEW_MS;
    }
  }

  const provider: AuthStatus['provider'] = source === 'none' ? 'none' : 'codex';

  const status: AuthStatus = {
    authMode: summary.authMode,
    provider,
    source,
    authFile: config.authFile,
    credentialType,
    accountIdPresent: Boolean(accountId),
    accountIdPartial: accountId ? partialAccountId(accountId) : undefined,
    expiresAt,
    expiresInSeconds,
    refreshDueSoon,
    configuredModel: config.model,
    activeModel: summary.activeModel,
    modelFallback: summary.modelFallback,
  };

  if (summary.authMode === 'none') {
    status.hint = 'Run `juno login` or set OPENAI_API_KEY.';
  }

  return status;
}

export function normalizeApiKey(value: string): string {
  return value.trim();
}

export function createStoredApiCredential(apiKey: string) {
  return createApiKeyCredential(normalizeApiKey(apiKey));
}
