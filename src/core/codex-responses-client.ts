import { arch, platform, release } from 'node:os';

import { z } from 'zod';

import { extractAccountIdFromJwt } from '@/auth/codex';
import type {
  ModelClient,
  ModelStep,
  ModelUsage,
  SerializedMessage,
  ToolCall,
  ToolName,
  ToolSpec,
} from '@/types';

function estimateUsage(input: string, output: string): ModelUsage {
  return {
    input: Math.ceil(input.length / 4),
    output: Math.ceil(output.length / 4),
    estimated: true,
  };
}

export type CodexRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
};

type CodexClientConfig = {
  baseUrl: string;
  accessToken: string;
  accountId: string;
  sessionId?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  retry?: CodexRetryOptions;
};

const DEFAULT_RETRY: Required<CodexRetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000,
  jitterRatio: 0.25,
};

export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return null;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function fetchCodexWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: {
    sleep?: (ms: number) => Promise<void>;
    retry?: CodexRetryOptions;
    random?: () => number;
  } = {},
): Promise<Response> {
  const cfg = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let response: Response | undefined;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    response = await fetchImpl(url, init);
    if (response.ok) return response;
    if (!isRetryableStatus(response.status) || attempt === cfg.maxAttempts) {
      return response;
    }
    const headerWait = parseRetryAfter(response.headers.get('retry-after'));
    const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
    const wait = headerWait ?? exp;
    const jitter = random() * wait * cfg.jitterRatio;
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // ignore
      }
    }
    await sleep(wait + jitter);
  }
  // Unreachable: the loop always returns or sleeps and loops; TS satisfied.
  return response as Response;
}

type CodexInputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant';
      content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

type CodexToolDef = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
};

type CodexRequestBody = {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  include: string[];
  parallel_tool_calls: boolean;
  tool_choice: 'auto';
  tools?: CodexToolDef[];
  prompt_cache_key?: string;
};

export function buildCodexInput(
  messages: SerializedMessage[],
): CodexInputItem[] {
  const input: CodexInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message.content }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.toolCallId,
          name: call.toolName,
          arguments: JSON.stringify(call.input ?? {}),
        });
      }
      continue;
    }
    for (const result of message.results) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output:
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output),
      });
    }
  }

  return input;
}

export function buildCodexTools(specs: ToolSpec[]): CodexToolDef[] {
  return specs.map((spec) => {
    const schema = spec.inputSchema as z.ZodType;
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;
    return {
      type: 'function' as const,
      name: spec.name,
      description: spec.description,
      parameters: json,
      strict: false,
    };
  });
}

export function buildCodexHeaders(config: CodexClientConfig): Headers {
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${config.accessToken}`);
  headers.set('chatgpt-account-id', config.accountId);
  headers.set('OpenAI-Beta', 'responses=experimental');
  headers.set('accept', 'text/event-stream');
  headers.set('content-type', 'application/json');
  headers.set('originator', 'juno');
  headers.set('User-Agent', `juno (${platform()} ${release()}; ${arch()})`);
  if (config.sessionId) {
    headers.set('session_id', config.sessionId);
    headers.set('x-client-request-id', config.sessionId);
  }
  return headers;
}

export function resolveCodexUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/codex/responses')) return trimmed;
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`;
  return `${trimmed}/codex/responses`;
}

type SseEvent = Record<string, unknown> & { type?: string };

async function* parseSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join('\n').trim();
          if (data && data !== '[DONE]') {
            yield JSON.parse(data) as SseEvent;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type CodexErrorPayload = {
  error?: {
    code?: string;
    type?: string;
    message?: string;
    plan_type?: string;
    resets_at?: number;
  };
  detail?: string;
};

const CHATGPT_ACCOUNT_SAFE_MODEL_HINT =
  'gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2';

function friendlyError(status: number, raw: string): Error {
  let message = raw || 'Codex request failed';
  try {
    const parsed = JSON.parse(raw) as CodexErrorPayload;
    const err = parsed.error;
    if (err) {
      const code = err.code ?? err.type ?? '';
      if (
        status === 429 ||
        /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)
      ) {
        const plan = err.plan_type
          ? ` (${err.plan_type.toLowerCase()} plan)`
          : '';
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : '';
        return new Error(`ChatGPT usage limit reached${plan}.${when}`.trim());
      }
      message = err.message ?? message;
    }
    if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
      message = parsed.detail;
    }
  } catch {
    // ignore json parse errors and use the raw text
  }
  if (/not supported when using Codex with a ChatGPT account/i.test(message)) {
    return new Error(
      `${message} Try one of: ${CHATGPT_ACCOUNT_SAFE_MODEL_HINT} — or unset JUNO_CODEX_MODEL to let juno pick a safe default.`,
    );
  }
  return new Error(`Codex backend error ${status}: ${message}`);
}

type PendingFunctionCall = {
  name: string;
  callId: string;
  args: string;
};

export function createCodexResponsesClient(
  config: CodexClientConfig,
): ModelClient {
  return {
    async runStep({
      model,
      systemPrompt,
      messages,
      tools,
      onTextDelta,
      onToolCall,
      onUsage,
    }): Promise<ModelStep> {
      const accountId =
        config.accountId.length > 0
          ? config.accountId
          : (extractAccountIdFromJwt(config.accessToken) ?? '');
      if (!accountId) {
        throw new Error(
          'Could not determine ChatGPT account id from OAuth credential. Re-run `juno login`.',
        );
      }

      const body: CodexRequestBody = {
        model,
        instructions: systemPrompt,
        input: buildCodexInput(messages),
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        parallel_tool_calls: true,
        tool_choice: 'auto',
        prompt_cache_key: config.sessionId,
      };

      if (tools.length > 0) {
        body.tools = buildCodexTools(tools);
      }

      const validToolNames = new Set<ToolName>(tools.map((t) => t.name));

      const headers = buildCodexHeaders({ ...config, accountId });
      const url = resolveCodexUrl(config.baseUrl);
      const fetchImpl = config.fetchImpl ?? fetch;

      const response = await fetchCodexWithRetry(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        { sleep: config.sleepImpl, retry: config.retry },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw friendlyError(response.status, text);
      }

      let text = '';
      const seenToolCalls: ToolCall[] = [];
      const pending = new Map<number, PendingFunctionCall>();
      let finishReason = 'stop';

      for await (const event of parseSse(response)) {
        const type = event.type;

        if (type === 'response.output_text.delta') {
          const delta = asString(event.delta) ?? '';
          if (delta) {
            text += delta;
            onTextDelta?.(delta);
          }
          continue;
        }

        if (type === 'response.output_item.added') {
          const item = (event as { item?: Record<string, unknown> }).item;
          const outputIndex = (event as { output_index?: number }).output_index;
          if (
            item?.type === 'function_call' &&
            typeof outputIndex === 'number'
          ) {
            pending.set(outputIndex, {
              name: asString(item.name) ?? '',
              callId: asString(item.call_id) ?? asString(item.id) ?? '',
              args: '',
            });
          }
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          const outputIndex = (event as { output_index?: number }).output_index;
          const delta = asString(event.delta) ?? '';
          if (typeof outputIndex === 'number') {
            const entry = pending.get(outputIndex);
            if (entry) {
              entry.args += delta;
            }
          }
          continue;
        }

        if (type === 'response.output_item.done') {
          const item = (event as { item?: Record<string, unknown> }).item;
          const outputIndex = (event as { output_index?: number }).output_index;
          if (
            item?.type === 'function_call' &&
            typeof outputIndex === 'number'
          ) {
            const entry = pending.get(outputIndex);
            const name = asString(item.name) ?? entry?.name ?? '';
            const callId =
              asString(item.call_id) ??
              entry?.callId ??
              asString(item.id) ??
              '';
            const argsText = asString(item.arguments) ?? entry?.args ?? '';
            const toolName = validToolNames.has(name as ToolName)
              ? (name as ToolName)
              : undefined;
            if (!toolName && name) {
              console.warn(
                `[juno] Codex returned function_call for unknown tool '${name}'; ignoring`,
              );
            }
            if (toolName && callId) {
              let parsedArgs: Record<string, unknown> = {};
              if (argsText) {
                try {
                  parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
                } catch {
                  parsedArgs = {};
                }
              }
              const call: ToolCall = {
                toolCallId: callId,
                toolName,
                input: parsedArgs,
              };
              seenToolCalls.push(call);
              onToolCall?.(call);
            }
            pending.delete(outputIndex);
          }
          continue;
        }

        if (
          type === 'response.completed' ||
          type === 'response.done' ||
          type === 'response.incomplete'
        ) {
          const response = (
            event as {
              response?: { status?: string; incomplete_details?: unknown };
            }
          ).response;
          finishReason = response?.status ?? 'stop';
          break;
        }

        if (type === 'response.failed') {
          const errPayload = (
            event as {
              response?: { error?: { code?: string; message?: string } };
            }
          ).response?.error;
          const code = errPayload?.code ?? '';
          const message = errPayload?.message ?? 'Codex response failed';
          if (
            /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(
              code,
            )
          ) {
            throw new Error(`ChatGPT usage limit reached: ${message}`);
          }
          throw new Error(message);
        }

        if (type === 'error') {
          const message =
            asString((event as { message?: unknown }).message) ?? 'Codex error';
          throw new Error(message);
        }
      }

      const inputForEstimate = `${systemPrompt}\n${messages
        .map((m) =>
          m.role === 'user' || m.role === 'assistant' ? (m.content ?? '') : '',
        )
        .join('\n')}`;
      const usage = estimateUsage(inputForEstimate, text);
      onUsage?.(usage);

      return {
        text,
        toolCalls: seenToolCalls,
        finishReason,
        usage,
      };
    },
  };
}
