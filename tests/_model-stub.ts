import type {
  ModelClient,
  SerializedMessage,
  TodoItem,
  ToolCall,
} from '@/types';

export type ScriptedStep =
  | { kind: 'plain'; text: string }
  | { kind: 'read'; filePath: string }
  | { kind: 'edit'; filePath: string; oldString: string; newString: string }
  | { kind: 'todo'; todos: TodoItem[] };

export type ScriptedClientOptions = {
  toolCallPrefix?: string;
  finalText?: string;
};

export type ScriptedClientObserved = {
  calls: number;
  freshUserCalls: number;
  continuationCalls: number;
  messagesSeen: SerializedMessage[][];
  toolCallIdsEmitted: string[];
  remainingSteps: () => number;
};

export type ScriptedClient = {
  client: ModelClient;
  observed: ScriptedClientObserved;
};

const STUB_USAGE = { input: 5, output: 5 } as const;

export function createScriptedModelClient(
  steps: ScriptedStep[],
  options: ScriptedClientOptions = {},
): ScriptedClient {
  const queue: ScriptedStep[] = [...steps];
  const prefix = options.toolCallPrefix ?? 'stub';
  const finalText = options.finalText ?? 'done';
  const messagesSeen: SerializedMessage[][] = [];
  const toolCallIdsEmitted: string[] = [];
  let callCount = 0;
  let freshUserCalls = 0;
  let continuationCalls = 0;
  let toolCounter = 0;

  const observed: ScriptedClientObserved = {
    get calls() {
      return callCount;
    },
    get freshUserCalls() {
      return freshUserCalls;
    },
    get continuationCalls() {
      return continuationCalls;
    },
    messagesSeen,
    toolCallIdsEmitted,
    remainingSteps: () => queue.length,
  };

  const client: ModelClient = {
    async runStep({ messages, onTextDelta, onToolCall, onUsage }) {
      callCount += 1;
      messagesSeen.push(messages.map(cloneMessage));

      const lastMessage = messages.at(-1);
      if (lastMessage?.role === 'tool') {
        continuationCalls += 1;
        if (onTextDelta) onTextDelta(finalText);
        if (onUsage) onUsage({ ...STUB_USAGE });
        return {
          text: finalText,
          toolCalls: [],
          finishReason: 'stop',
          usage: { ...STUB_USAGE },
        };
      }

      freshUserCalls += 1;
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `scripted stub exhausted: runStep #${callCount} requested a fresh-turn step but none remain`,
        );
      }

      if (next.kind === 'plain') {
        if (next.text.length > 0 && onTextDelta) onTextDelta(next.text);
        if (onUsage) onUsage({ ...STUB_USAGE });
        return {
          text: next.text,
          toolCalls: [],
          finishReason: 'stop',
          usage: { ...STUB_USAGE },
        };
      }

      toolCounter += 1;
      const toolCallId = `${prefix}-call-${toolCounter}`;
      let call: ToolCall;
      if (next.kind === 'read') {
        call = {
          toolCallId,
          toolName: 'Read',
          input: { filePath: next.filePath },
        };
      } else if (next.kind === 'edit') {
        call = {
          toolCallId,
          toolName: 'Edit',
          input: {
            filePath: next.filePath,
            oldString: next.oldString,
            newString: next.newString,
          },
        };
      } else {
        call = {
          toolCallId,
          toolName: 'TodoWrite',
          input: { todos: next.todos },
        };
      }

      toolCallIdsEmitted.push(toolCallId);
      if (onToolCall) onToolCall(call);
      if (onUsage) onUsage({ ...STUB_USAGE });
      return {
        text: '',
        toolCalls: [call],
        finishReason: 'tool-calls',
        usage: { ...STUB_USAGE },
      };
    },
  };

  return { client, observed };
}

function cloneMessage(message: SerializedMessage): SerializedMessage {
  if (message.role === 'tool') {
    return { role: 'tool', results: [...message.results] };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
    };
  }
  return { role: 'user', content: message.content };
}
