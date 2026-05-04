import { createOpenAI } from '@ai-sdk/openai';
import type { ModelMessage } from 'ai';
import { tool as defineTool, streamText } from 'ai';

import type {
  AgentConfig,
  ModelClient,
  SerializedMessage,
  ToolCall,
} from '@/types';

function toModelMessages(messages: SerializedMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: [{ type: 'text' as const, text: message.content }],
      };
    }
    if (message.role === 'assistant') {
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
        output: result.output as never,
        isError: result.isError,
      })),
    };
  }) as ModelMessage[];
}

export function createAiSdkModelClient(config: AgentConfig): ModelClient {
  if (!config.apiKey) {
    throw new Error(
      'Missing API credential. Set OPENAI_API_KEY or run `agent login --with-api-key`.',
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
    }) {
      const toolSet = Object.fromEntries(
        tools.map((spec) => [
          spec.name,
          defineTool({
            description: spec.description,
            inputSchema: spec.inputSchema,
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

      return {
        text,
        toolCalls: seenToolCalls,
        finishReason: await result.finishReason,
      };
    },
  };
}
