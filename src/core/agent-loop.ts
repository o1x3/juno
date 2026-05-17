import { appendSessionEvent } from '@/core/session-store';
import type { SnapshotStore } from '@/core/snapshot';
import type {
  AgentConfig,
  ApprovalDecision,
  ApprovalRequest,
  ModelClient,
  ModelUsage,
  ProjectInstructionSet,
  QuestionRequest,
  QuestionResponse,
  RawAgentTurnResult,
  SerializedMessage,
  ToolCall,
  ToolResult,
  ToolSpec,
} from '@/types';

type TurnOptions = {
  config: AgentConfig;
  sessionId: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  messages: SerializedMessage[];
  tools: ToolSpec[];
  modelClient: ModelClient;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: ToolResult) => void;
  onUsage?: (usage: ModelUsage) => void;
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  requestUserAnswer?: (req: QuestionRequest) => Promise<QuestionResponse>;
  // When present, a filesystem snapshot is captured at the start of the turn
  // (right after the user message is recorded) so `/undo` can revert it.
  snapshot?: SnapshotStore;
};

function mergeUsage(
  acc: ModelUsage | undefined,
  next: ModelUsage | undefined,
): ModelUsage | undefined {
  if (!next) return acc;
  if (!acc) return { ...next };
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    reasoning: (acc.reasoning ?? 0) + (next.reasoning ?? 0) || undefined,
    cacheRead: (acc.cacheRead ?? 0) + (next.cacheRead ?? 0) || undefined,
    cacheWrite: (acc.cacheWrite ?? 0) + (next.cacheWrite ?? 0) || undefined,
    estimated: acc.estimated || next.estimated,
  };
}

export async function runAgentTurn(
  options: TurnOptions,
): Promise<RawAgentTurnResult> {
  const {
    config,
    sessionId,
    model,
    systemPrompt,
    userInput,
    messages,
    tools,
    modelClient,
    onTextDelta,
    onToolCall,
    onToolResult,
    onUsage,
    requestApproval,
    requestUserAnswer,
    snapshot,
  } = options;

  const conversation = [
    ...messages,
    { role: 'user', content: userInput } as const,
  ];
  const toolCallsSeen: ToolCall[] = [];
  const toolResultsSeen: ToolResult[] = [];
  await appendSessionEvent(config.sessionsDir, sessionId, {
    type: 'user_message',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: userInput },
  });

  // Capture a pre-turn filesystem snapshot so `/undo` can revert this turn's
  // edits. Best-effort: a snapshot failure must never block the turn.
  if (snapshot) {
    try {
      const hash = await snapshot.create();
      if (hash) {
        await appendSessionEvent(config.sessionsDir, sessionId, {
          type: 'snapshot',
          timestamp: new Date().toISOString(),
          sessionId,
          hash,
        });
      }
    } catch {
      // ignore — snapshots are advisory
    }
  }

  let finalAssistantText = '';
  let aggregateUsage: ModelUsage | undefined;
  for (let step = 0; step < config.maxSteps; step += 1) {
    const stepResult = await modelClient.runStep({
      model,
      systemPrompt,
      messages: conversation,
      tools,
      onTextDelta,
      onToolCall: (call) => {
        toolCallsSeen.push(call);
        onToolCall?.(call);
      },
      onUsage: (usage) => {
        aggregateUsage = mergeUsage(aggregateUsage, usage);
        if (aggregateUsage) onUsage?.(aggregateUsage);
      },
    });

    const assistantMessage: SerializedMessage = {
      role: 'assistant',
      content: stepResult.text,
      toolCalls: stepResult.toolCalls,
    };
    conversation.push(assistantMessage);
    await appendSessionEvent(config.sessionsDir, sessionId, {
      type: 'assistant_message',
      timestamp: new Date().toISOString(),
      message: assistantMessage,
    });

    for (const call of stepResult.toolCalls) {
      await appendSessionEvent(config.sessionsDir, sessionId, {
        type: 'tool_call',
        timestamp: new Date().toISOString(),
        call,
      });
    }

    if (stepResult.toolCalls.length === 0) {
      finalAssistantText = stepResult.text;
      break;
    }

    const results: ToolResult[] = [];
    for (const call of stepResult.toolCalls) {
      const spec = tools.find((tool) => tool.name === call.toolName);
      if (!spec) {
        const missingResult: ToolResult = {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: `Tool not found: ${call.toolName}`,
          isError: true,
        };
        results.push(missingResult);
        continue;
      }

      const result = await spec.execute(
        { ...call.input, toolCallId: call.toolCallId },
        {
          cwd: config.cwd,
          outputLimit: config.toolOutputLimit,
          readLineLimit: config.readLineLimit,
          bashTimeoutMs: config.bashTimeoutMs,
          sessionsDir: config.sessionsDir,
          sessionId,
          requestApproval,
          requestUserAnswer,
        },
      );
      results.push(result);
      toolResultsSeen.push(result);
      onToolResult?.(result);
      await appendSessionEvent(config.sessionsDir, sessionId, {
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        result,
      });
    }

    conversation.push({ role: 'tool', results });
  }

  await appendSessionEvent(config.sessionsDir, sessionId, {
    type: 'status_meta',
    timestamp: new Date().toISOString(),
    status: 'turn_completed',
    sessionId,
    cwd: config.cwd,
    model,
  });

  return {
    assistantText: finalAssistantText,
    toolCalls: toolCallsSeen,
    toolResults: toolResultsSeen,
    messages: conversation,
    usage: aggregateUsage,
  };
}

export async function buildPromptFromInstructions(
  instructions: ProjectInstructionSet,
): Promise<string> {
  return instructions.mergedContent;
}
