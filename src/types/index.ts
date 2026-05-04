import type { ZodType } from 'zod';

export type AgentRole = 'user' | 'assistant' | 'tool';

export type SerializedMessage =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      results: ToolResult[];
    };

export type SessionEvent =
  | {
      type: 'user_message';
      timestamp: string;
      message: Extract<SerializedMessage, { role: 'user' }>;
    }
  | {
      type: 'assistant_message';
      timestamp: string;
      message: Extract<SerializedMessage, { role: 'assistant' }>;
    }
  | {
      type: 'tool_call';
      timestamp: string;
      call: ToolCall;
    }
  | {
      type: 'tool_result';
      timestamp: string;
      result: ToolResult;
    }
  | {
      type: 'status_meta';
      timestamp: string;
      status: 'session_started' | 'session_resumed' | 'turn_completed';
      sessionId: string;
      cwd: string;
      model: string;
      note?: string;
    };

export type ToolCall = {
  toolCallId: string;
  toolName: ToolName;
  input: Record<string, unknown>;
};

export type ToolResult = {
  toolCallId: string;
  toolName: ToolName;
  output: unknown;
  isError?: boolean;
};

export type ToolName = 'Read' | 'Write' | 'Edit' | 'Bash' | 'Grep';

export type ToolSpec = {
  name: ToolName;
  description: string;
  inputSchema: ZodType;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
};

export type ToolContext = {
  cwd: string;
  outputLimit: number;
  readLineLimit: number;
  bashTimeoutMs: number;
};

export type CredentialRecord =
  | {
      provider: 'codex';
      type: 'api-key';
      apiKey: string;
      createdAt: string;
    }
  | {
      provider: 'codex';
      type: 'oauth';
      apiKey?: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      accountId?: string;
      createdAt: string;
    };

export type ProjectInstructionFile = {
  kind: 'AGENTS.md' | 'CLAUDE.md';
  path: string;
  directory: string;
  content: string;
};

export type ProjectInstructionSet = {
  cwd: string;
  gitRoot: string;
  files: ProjectInstructionFile[];
  mergedContent: string;
};

export type AgentConfig = {
  cwd: string;
  homeDir: string;
  authFile: string;
  sessionsDir: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxSteps: number;
  toolOutputLimit: number;
  readLineLimit: number;
  bashTimeoutMs: number;
};

export type SessionSummary = {
  id: string;
  path: string;
  updatedAt: string;
  eventCount: number;
};

export type ModelStep = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
};

export type ModelClient = {
  runStep(args: {
    model: string;
    systemPrompt: string;
    messages: SerializedMessage[];
    tools: ToolSpec[];
    onTextDelta?: (delta: string) => void;
    onToolCall?: (call: ToolCall) => void;
  }): Promise<ModelStep>;
};

export type AgentTurnResult = {
  assistantText: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  messages: SerializedMessage[];
};
