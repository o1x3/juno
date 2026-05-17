import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { tool as defineTool, jsonSchema, streamText } from 'ai';

import type {
  AgentConfig,
  ModelClient,
  ModelUsage,
  SerializedMessage,
  ToolCall,
} from '@/types';

export function toToolResultOutput(output: unknown) {
  if (typeof output === 'string') {
    return { type: 'text' as const, value: output };
  }

  return { type: 'json' as const, value: output };
}

// A tool result carrying image media becomes an AI SDK `content` output with a
// `media` part so a vision model actually sees the pixels. Falls back to the
// JSON/text form for everything else.
function toToolResultOutputWithMedia(result: {
  output: unknown;
  media?: { kind: 'image'; dataUrl: string; mediaType: string };
}) {
  if (result.media?.kind === 'image') {
    const comma = result.media.dataUrl.indexOf(',');
    const base64 =
      comma >= 0 ? result.media.dataUrl.slice(comma + 1) : result.media.dataUrl;
    return {
      type: 'content' as const,
      value: [
        {
          type: 'media' as const,
          data: base64,
          mediaType: result.media.mediaType,
        },
      ],
    };
  }
  return toToolResultOutput(result.output);
}

export function toModelMessages(messages: SerializedMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content,
      };
    }
    if (message.role === 'assistant') {
      if (!message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content,
        };
      }

      return {
        role: 'assistant',
        content: [
          ...(message.content
            ? [{ type: 'text' as const, text: message.content }]
            : []),
          ...((message.toolCalls ?? []).map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })) ?? []),
        ],
      };
    }
    return {
      role: 'tool',
      content: message.results.map((result) => ({
        type: 'tool-result' as const,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: toToolResultOutputWithMedia(result),
      })),
    };
  }) as ModelMessage[];
}

function normalizeUsage(raw: unknown): ModelUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const input =
    num(r.inputTokens) ?? num(r.input_tokens) ?? num(r.promptTokens);
  const output =
    num(r.outputTokens) ?? num(r.output_tokens) ?? num(r.completionTokens);
  if (input === undefined && output === undefined) return undefined;
  const reasoning = num(r.reasoningTokens) ?? num(r.reasoning_tokens);
  const cacheRead =
    num(r.cachedInputTokens) ??
    num(r.cached_input_tokens) ??
    num(r.cacheReadInputTokens) ??
    num(r.cache_read_input_tokens);
  const cacheWrite =
    num(r.cacheCreationInputTokens) ??
    num(r.cache_creation_input_tokens) ??
    num(r.cacheWriteInputTokens);
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning,
    cacheRead,
    cacheWrite,
  };
}

export function createAiSdkModelClient(config: AgentConfig): ModelClient {
  if (!config.apiKey) {
    throw new Error(
      'Missing API credential. Set OPENAI_API_KEY or run `juno login --with-api-key`.',
    );
  }

  const provider = createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  return {
    async runStep({
      model: modelName,
      systemPrompt,
      messages,
      tools,
      onTextDelta,
      onToolCall,
      onUsage,
    }) {
      const toolSet = Object.fromEntries(
        tools.map((spec) => [
          spec.name,
          defineTool({
            description: spec.description,
            inputSchema: spec.parameters
              ? jsonSchema(spec.parameters)
              : spec.inputSchema,
          }),
        ]),
      );

      const result = streamText({
        model: provider.responses(modelName),
        system: systemPrompt,
        messages: toModelMessages(messages),
        tools: toolSet,
      });

      let text = '';
      const seenToolCalls: ToolCall[] = [];

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
          onTextDelta?.(chunk.text);
        }

        if (chunk.type === 'tool-call') {
          const call: ToolCall = {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName as ToolCall['toolName'],
            input: chunk.input as Record<string, unknown>,
          };
          seenToolCalls.push(call);
          onToolCall?.(call);
        }
      }

      let usage: ModelUsage | undefined;
      try {
        usage = normalizeUsage(await result.usage);
      } catch {
        usage = undefined;
      }
      if (usage) onUsage?.(usage);

      return {
        text,
        toolCalls: seenToolCalls,
        finishReason: await result.finishReason,
        usage,
      };
    },
  };
}
