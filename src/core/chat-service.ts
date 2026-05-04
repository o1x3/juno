import { createApiKeyCredential } from '@/auth/codex';
import { loadCredential, resolveCredential } from '@/auth/storage';
import { runAgentTurn } from '@/core/agent-loop';
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
import type { AgentConfig, AgentTurnResult } from '@/types';

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

  const stored = await loadCredential(config.authFile);
  const credential = resolveCredential(config.apiKey, stored);
  const runtimeConfig: AgentConfig =
    credential?.type === 'api-key'
      ? { ...config, apiKey: credential.apiKey }
      : credential?.type === 'oauth' && credential.apiKey
        ? { ...config, apiKey: credential.apiKey }
        : config.apiKey
          ? config
          : {
              ...config,
              apiKey: undefined,
            };

  const instructions = await loadProjectInstructions(config.cwd);
  const systemPrompt = buildSystemPrompt(instructions);
  const modelClient = createAiSdkModelClient(runtimeConfig);
  const result = await runAgentTurn({
    config: runtimeConfig,
    sessionId,
    systemPrompt,
    userInput: options.prompt,
    messages,
    tools: createBuiltinTools({
      cwd: runtimeConfig.cwd,
      outputLimit: runtimeConfig.toolOutputLimit,
      readLineLimit: runtimeConfig.readLineLimit,
      bashTimeoutMs: runtimeConfig.bashTimeoutMs,
    }),
    modelClient,
    onTextDelta: options.onTextDelta,
    onToolCall: options.onToolCall as never,
    onToolResult: options.onToolResult as never,
  });

  return { sessionId, result };
}

export function normalizeApiKey(value: string): string {
  return value.trim();
}

export function createStoredApiCredential(apiKey: string) {
  return createApiKeyCredential(normalizeApiKey(apiKey));
}
