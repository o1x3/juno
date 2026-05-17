import type { ZodType } from 'zod';

import type { DiffPayload } from '@/core/diff';

export type AgentRole = 'user' | 'assistant' | 'tool';

export type AgentMode = 'plan' | 'exec' | 'yolo';

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
    }
  | {
      type: 'snapshot';
      timestamp: string;
      sessionId: string;
      hash: string;
    }
  | {
      type: 'compaction';
      timestamp: string;
      summary: string;
      tokensBefore: number;
      messagesSummarized: number;
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
  media?: ToolResultMedia;
};

export type BuiltinToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'MultiEdit'
  | 'apply_patch'
  | 'Bash'
  | 'Grep'
  | 'Glob'
  | 'LS'
  | 'TodoWrite'
  | 'AskUserQuestion'
  | 'Task'
  | 'Skill'
  | 'LSP'
  | 'view_image'
  | 'WebFetch'
  | 'WebSearch'
  | 'spawn_agent'
  | 'send_input'
  | 'wait_agent'
  | 'close_agent'
  | 'list_agents';

// Optional multimodal payload on a tool result. When present, the model-client
// layer serializes it into the provider's native image input so a vision model
// actually sees the pixels (mirrors codex's view_image FunctionCallOutput
// ContentItems path).
export type ToolResultMedia = {
  kind: 'image';
  dataUrl: string;
  mediaType: string;
  detail?: 'original' | null;
};

export type PatchFileOp = 'add' | 'update' | 'delete' | 'move';

export type PatchFilePreview = {
  path: string;
  op: PatchFileOp;
  movePath?: string;
  diff?: DiffPayload;
};

// `(string & {})` keeps IntelliSense for the literal builtins while letting
// MCP tools (named `<server>_<tool>`) flow through the type system at runtime.
export type ToolName = BuiltinToolName | (string & {});

export type ApprovalPreview =
  | {
      kind: 'write';
      path: string;
      bytes: number;
      created: boolean;
      diff?: DiffPayload;
    }
  | { kind: 'edit'; path: string; diff?: DiffPayload }
  | { kind: 'multi-edit'; path: string; created: boolean; diff?: DiffPayload }
  | { kind: 'apply-patch'; files: PatchFilePreview[] }
  | { kind: 'bash'; command: string }
  | {
      kind: 'mcp';
      server: string;
      tool: string;
      args: Record<string, unknown>;
    };

export type ApprovalRequest = {
  toolName: ToolName;
  preview: ApprovalPreview;
};

export type ApprovalDecision =
  | 'approve'
  | 'approve_forever'
  | 'reject'
  | { decision: 'reject'; reason: string };

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionRequest = {
  questionId: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  isSecret?: boolean;
  progress?: { current: number; total: number };
};

export type QuestionResponse =
  | { kind: 'answered'; selected: string[]; custom?: string }
  | { kind: 'dismissed' };

export type ToolSpec = {
  name: ToolName;
  description: string;
  // Static `inputSchema` for built-in tools; MCP tools may supply `parameters`
  // (raw JSON Schema returned by the server) instead. When both are present,
  // `parameters` wins for outbound tool-definition serialization.
  inputSchema: ZodType;
  parameters?: Record<string, unknown>;
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
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  requestUserAnswer?: (req: QuestionRequest) => Promise<QuestionResponse>;
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
  yoloAcknowledged: boolean;
  exaApiKey?: string;
  mcpConfigPath?: string;
  // Per-turn git snapshots for `/undo`. Auto-disabled outside a git repo.
  snapshots: boolean;
  // Context compaction.
  autoCompact: boolean;
  contextWindow: number;
  compactReserveTokens: number;
  compactKeepRecentTokens: number;
  // Multi-agent (spawn_agent / send_input / wait_agent / close_agent).
  multiAgent: boolean;
  multiAgentVersion: 'v1' | 'v2';
};

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop';

export type HookCommand = {
  type: 'command';
  command: string;
  timeout?: number;
};

export type HookMatcher = {
  matcher?: string;
  hooks: HookCommand[];
};

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

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
