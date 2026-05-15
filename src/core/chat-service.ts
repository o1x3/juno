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
import { generateSessionName, type NamingDeps } from '@/core/naming';
import { buildSystemPrompt } from '@/core/prompt';
import {
  appendSessionEvent,
  appendSessionMeta,
  createSessionId,
  findSessionName,
  readSessionEvents,
  restoreMessages,
} from '@/core/session-store';
import { createBuiltinTools } from '@/core/tools';
import type {
  AgentConfig,
  AgentMode,
  AgentTurnResult,
  ApprovalDecision,
  ApprovalRequest,
  AuthMode,
  AuthStatus,
  ModelClient,
  ModelFallback,
  ModelUsage,
  QuestionRequest,
  QuestionResponse,
  ToolCall,
  ToolName,
  ToolResult,
  ToolSpec,
} from '@/types';

export const PLAN_MODE_TOOLS: ReadonlySet<ToolName> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'TodoWrite',
  'AskUserQuestion',
]);

type ChatOptions = {
  config: AgentConfig;
  prompt: string;
  sessionId?: string;
  mode?: AgentMode;
  modelClient?: ModelClient;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  onUsage?: (usage: ModelUsage) => void;
  onSessionName?: (name: string) => void;
  namingDeps?: NamingDeps;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  requestUserAnswer?: (req: QuestionRequest) => Promise<QuestionResponse>;
};

type RoutingResolution = {
  runtimeConfig: AgentConfig;
  modelClient: ModelClient;
  authMode: AuthMode;
  activeModel: string;
  modelFallback?: ModelFallback;
};

function pickModelForMode(config: AgentConfig, mode: AgentMode): string {
  if (mode === 'plan') return config.planModel;
  // exec and yolo both run with the exec model.
  return config.execModel;
}

export function filterToolsForMode(
  tools: ToolSpec[],
  mode: AgentMode,
): ToolSpec[] {
  if (mode === 'plan') {
    return tools.filter((t) => PLAN_MODE_TOOLS.has(t.name));
  }
  // exec and yolo expose the full tool registry.
  return tools;
}

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
  const mode: AgentMode = options.mode ?? 'exec';
  const turnModel = pickModelForMode(config, mode);
  const isFreshSession = !options.sessionId;
  const sessionId = options.sessionId ?? createSessionId();
  const events = options.sessionId
    ? await readSessionEvents(config.sessionsDir, sessionId)
    : [];
  const messages = restoreMessages(events);
  const existingName = findSessionName(events);
  if (existingName) options.onSessionName?.(existingName);

  if (isFreshSession) {
    await appendSessionEvent(config.sessionsDir, sessionId, {
      type: 'status_meta',
      timestamp: new Date().toISOString(),
      status: 'session_started',
      sessionId,
      cwd: config.cwd,
      model: turnModel,
    });
  }

  const configForRouting = { ...config, model: turnModel };
  const routing: RoutingResolution = options.modelClient
    ? {
        runtimeConfig: configForRouting,
        modelClient: options.modelClient,
        authMode: 'api-key',
        activeModel: turnModel,
      }
    : await resolveRouting(configForRouting);

  const instructions = await loadProjectInstructions(config.cwd);
  const systemPrompt = buildSystemPrompt(instructions, mode);
  const allTools = createBuiltinTools({
    cwd: routing.runtimeConfig.cwd,
    outputLimit: routing.runtimeConfig.toolOutputLimit,
    readLineLimit: routing.runtimeConfig.readLineLimit,
    bashTimeoutMs: routing.runtimeConfig.bashTimeoutMs,
    sessionsDir: routing.runtimeConfig.sessionsDir,
    sessionId,
  });
  const tools = filterToolsForMode(allTools, mode);

  const result = await runAgentTurn({
    config: routing.runtimeConfig,
    sessionId,
    model: routing.activeModel,
    systemPrompt,
    userInput: options.prompt,
    messages,
    tools,
    modelClient: routing.modelClient,
    onTextDelta: options.onTextDelta,
    onToolCall: options.onToolCall,
    onToolResult: options.onToolResult,
    onUsage: options.onUsage,
    requestApproval: options.requestApproval,
    requestUserAnswer: options.requestUserAnswer,
  });

  if (isFreshSession && config.autoName && !existingName) {
    void (async () => {
      const name = await generateSessionName(
        options.prompt,
        config,
        options.namingDeps,
      );
      const finalName = name ?? sessionId;
      try {
        await appendSessionMeta(
          config.sessionsDir,
          sessionId,
          finalName,
          name ? 'auto' : 'manual',
        );
        options.onSessionName?.(finalName);
      } catch {
        // ignore
      }
    })();
  }

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
