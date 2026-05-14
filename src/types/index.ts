import type { ZodType } from 'zod';

export type AgentRole = 'user' | 'assistant' | 'tool';

export type AgentMode = 'plan' | 'exec';

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
    }
  | {
      type: 'session_meta';
      timestamp: string;
      name: string;
      source: 'auto' | 'manual';
    }
  | {
      type: 'todo_update';
      timestamp: string;
      todos: TodoItem[];
    };

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
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

export type ToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'MultiEdit'
  | 'Bash'
  | 'Grep'
  | 'Glob'
  | 'LS'
  | 'TodoWrite';

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
  sessionsDir: string;
  sessionId: string;
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

export type UiPreferences = {
  statusPane: 'visible' | 'hidden';
  statusPaneShortcut: string;
  theme: 'auto' | 'dark' | 'light';
  timestamps: boolean;
};

export type AgentConfig = {
  cwd: string;
  homeDir: string;
  configFile: string;
  authFile: string;
  sessionsDir: string;
  model: string;
  planModel: string;
  execModel: string;
  namingModel: string;
  autoName: boolean;
  apiKey?: string;
  baseUrl?: string;
  maxSteps: number;
  toolOutputLimit: number;
  readLineLimit: number;
  bashTimeoutMs: number;
  codexBackendUrl: string;
  codexModelOverride?: string;
  ui: UiPreferences;
  autoUpgrade: boolean;
  updateCheckEnabled: boolean;
};

export type AuthMode = 'api-key' | 'oauth-api-key' | 'oauth-codex' | 'none';

export type ModelFallback = {
  from: string;
  to: string;
  source: 'fresh' | 'cache' | 'static';
};

export type AuthStatus = {
  authMode: AuthMode;
  provider: 'codex' | 'none';
  source: 'env' | 'stored' | 'none';
  authFile: string;
  credentialType?: 'api-key' | 'oauth';
  accountIdPresent: boolean;
  accountIdPartial?: string;
  expiresAt?: string;
  expiresInSeconds?: number;
  refreshDueSoon?: boolean;
  configuredModel: string;
  activeModel: string;
  modelFallback?: ModelFallback;
  hint?: string;
};

export type SessionSummary = {
  id: string;
  path: string;
  updatedAt: string;
  eventCount: number;
  name?: string;
};

export type ModelUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimated?: boolean;
};

export type ModelStep = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: ModelUsage;
};

export type ModelClient = {
  runStep(args: {
    model: string;
    systemPrompt: string;
    messages: SerializedMessage[];
    tools: ToolSpec[];
    onTextDelta?: (delta: string) => void;
    onToolCall?: (call: ToolCall) => void;
    onUsage?: (usage: ModelUsage) => void;
  }): Promise<ModelStep>;
};

export type RawAgentTurnResult = {
  assistantText: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  messages: SerializedMessage[];
  usage?: ModelUsage;
};

export type AgentTurnResult = RawAgentTurnResult & {
  authMode: AuthMode;
  activeModel: string;
  modelFallback?: ModelFallback;
};
