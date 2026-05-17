import { createApiKeyCredential, extractAccountIdFromJwt } from '@/auth/codex';
import {
  DEFAULT_REFRESH_SKEW_MS,
  loadCredential,
  type RefreshOptions,
  refreshCredentialIfNearExpiry,
  resolveCredential,
} from '@/auth/storage';
import { runAgentTurn } from '@/core/agent-loop';
import { loadAgents, resolveAgentTools } from '@/core/agents';
import {
  discoverCodexModels,
  pickCodexModelForChatGptAccount,
} from '@/core/codex-models';
import { createCodexResponsesClient } from '@/core/codex-responses-client';
import { loadProjectInstructions } from '@/core/instructions';
import { availableLspServerIds } from '@/core/lsp';
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
import { loadSkills } from '@/core/skills';
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
  'Skill',
  'LSP',
  'view_image',
  'WebFetch',
  'WebSearch',
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
  exaApiKey?: string;
  fetchImpl?: typeof fetch;
  mcpTools?: ToolSpec[];
};

const SUMMARIZE_SYSTEM_PROMPT =
  'You summarize a web page for an LLM. Extract only the content that answers the user prompt. Be concise and faithful to the source. Output plain text only — no preamble, no markdown headers, no bullet glyphs.';

function buildSummarizeFn(
  client: ModelClient,
  model: string,
): (input: {
  prompt: string;
  content: string;
  url: string;
}) => Promise<string> {
  return async ({ prompt, content, url }) => {
    const trimmed =
      content.length > 60_000
        ? `${content.slice(0, 60_000)}\n…[truncated]`
        : content;
    const userText = `URL: ${url}\nUser prompt: ${prompt}\n\n--- PAGE CONTENT ---\n${trimmed}`;
    const step = await client.runStep({
      model,
      systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
      tools: [],
    });
    return step.text.trim();
  };
}

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
  // Summarize model: API-key paths use the cheap namingModel; OAuth-codex
  // routes have to stay on the resolved activeModel because the picker has
  // already filtered to ChatGPT-account-safe choices.
  const summarizeModel =
    routing.authMode === 'oauth-codex'
      ? routing.activeModel
      : config.namingModel;
  const summarize = buildSummarizeFn(routing.modelClient, summarizeModel);

  const agents = await loadAgents(config.cwd);
  const skills = await loadSkills(config.cwd, config.homeDir);
  // Probe once which language servers are on PATH; the LSP tool is only
  // offered when at least one is available (no dead/erroring surface).
  const lspServerIds = availableLspServerIds();
  // Sub-agents reuse the parent's model client + web/MCP tooling but never get
  // `Task` or `spawnSubAgent` (one branch deep — no recursion). Their writes
  // still flow through the same approval callbacks as the parent.
  const subAgentDeps = {
    fetchImpl: options.fetchImpl,
    summarize,
    exaApiKey: options.exaApiKey ?? config.exaApiKey,
    mcpTools: options.mcpTools,
    skills,
    lspServerIds,
  };
  const spawnSubAgent = async (req: {
    agent: (typeof agents)[number];
    description: string;
    prompt: string;
    taskId?: string;
  }) => {
    const childSessionId =
      req.taskId ?? `${sessionId}.sub-${crypto.randomUUID().slice(0, 8)}`;
    const priorEvents = req.taskId
      ? await readSessionEvents(config.sessionsDir, childSessionId)
      : [];
    const childMessages = restoreMessages(priorEvents);
    // OAuth-Codex routing has already filtered to a ChatGPT-account-safe
    // model; honoring a per-agent override there would risk a 400. API-key
    // routing can use the agent's preferred model.
    const childModel =
      req.agent.model && routing.authMode !== 'oauth-codex'
        ? req.agent.model
        : routing.activeModel;
    const childCtx = {
      cwd: routing.runtimeConfig.cwd,
      outputLimit: routing.runtimeConfig.toolOutputLimit,
      readLineLimit: routing.runtimeConfig.readLineLimit,
      bashTimeoutMs: routing.runtimeConfig.bashTimeoutMs,
      sessionsDir: routing.runtimeConfig.sessionsDir,
      sessionId: childSessionId,
    };
    const childAllTools = createBuiltinTools(childCtx, subAgentDeps);
    const allowed = new Set(
      resolveAgentTools(
        req.agent,
        childAllTools.map((t) => String(t.name)),
      ),
    );
    const childTools = childAllTools.filter((t) => allowed.has(String(t.name)));
    const childSystemPrompt = [
      req.agent.prompt,
      instructions.mergedContent
        ? `Project instructions:\n${instructions.mergedContent}`
        : '',
    ]
      .filter((s) => s.length > 0)
      .join('\n\n');
    const childResult = await runAgentTurn({
      config: { ...routing.runtimeConfig, model: childModel },
      sessionId: childSessionId,
      model: childModel,
      systemPrompt: childSystemPrompt,
      userInput: req.prompt,
      messages: childMessages,
      tools: childTools,
      modelClient: routing.modelClient,
      requestApproval: options.requestApproval,
      requestUserAnswer: options.requestUserAnswer,
    });
    return {
      taskId: childSessionId,
      text: childResult.assistantText,
      toolCalls: childResult.toolCalls.length,
    };
  };

  const allTools = createBuiltinTools(
    {
      cwd: routing.runtimeConfig.cwd,
      outputLimit: routing.runtimeConfig.toolOutputLimit,
      readLineLimit: routing.runtimeConfig.readLineLimit,
      bashTimeoutMs: routing.runtimeConfig.bashTimeoutMs,
      sessionsDir: routing.runtimeConfig.sessionsDir,
      sessionId,
    },
    {
      fetchImpl: options.fetchImpl,
      summarize,
      exaApiKey: options.exaApiKey ?? config.exaApiKey,
      mcpTools: options.mcpTools,
      agents,
      spawnSubAgent,
      skills,
      lspServerIds,
    },
  );
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
