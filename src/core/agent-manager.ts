// In-process multi-agent orchestration: spawn_agent / send_input /
// wait_agent / close_agent / list_agents. Tool surface and semantics mirror
// codex's agent tool (V1 = agent-id addressed; V2 = task-name addressed).
//
// Juno is a single process, so "background" agents are concurrent async turns
// tracked in a registry rather than separate OS threads. Each agent keeps its
// own conversation history, so send_input continues the same context.

import { z } from 'zod';

import type { AgentDefinition } from '@/core/agents';
import type { SerializedMessage, ToolResult, ToolSpec } from '@/types';

export type AgentStatus =
  | 'pending_init'
  | 'running'
  | 'interrupted'
  | 'shutdown'
  | 'not_found'
  | { completed: string | null }
  | { errored: string };

export type AgentTurnExecutor = (input: {
  agentDef: AgentDefinition;
  history: SerializedMessage[];
  prompt: string;
  model?: string;
  agentId: string;
}) => Promise<{
  text: string;
  history: SerializedMessage[];
  toolCalls: number;
}>;

type AgentRecord = {
  id: string;
  taskName: string;
  nickname?: string;
  agentDef: AgentDefinition;
  model?: string;
  status: AgentStatus;
  running: boolean;
  mailbox: string[];
  lastTaskMessage?: string;
  history: SerializedMessage[];
  finalMessage?: string;
};

export const MAX_CONCURRENT_AGENTS = 8;

function isFinal(s: AgentStatus): boolean {
  if (typeof s === 'string') return s === 'shutdown';
  return 'completed' in s || 'errored' in s;
}

export class AgentManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly executor: AgentTurnExecutor;
  private readonly resolveAgentDef: (
    type: string,
  ) => AgentDefinition | undefined;
  private counter = 0;
  // A promise that resolves on the next state change; used by wait_agent so it
  // does not busy-poll.
  private changeResolvers: Array<() => void> = [];

  constructor(opts: {
    executor: AgentTurnExecutor;
    resolveAgentDef: (type: string) => AgentDefinition | undefined;
  }) {
    this.executor = opts.executor;
    this.resolveAgentDef = opts.resolveAgentDef;
  }

  private bump(): void {
    const resolvers = this.changeResolvers;
    this.changeResolvers = [];
    for (const r of resolvers) r();
  }

  private nextChange(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.changeResolvers = this.changeResolvers.filter(
          (r) => r !== onChange,
        );
        resolve();
      }, timeoutMs);
      const onChange = () => {
        clearTimeout(timer);
        resolve();
      };
      this.changeResolvers.push(onChange);
    });
  }

  private resolve(target: string): AgentRecord | undefined {
    if (this.agents.has(target)) return this.agents.get(target);
    for (const rec of this.agents.values()) {
      if (rec.taskName === target) return rec;
    }
    return undefined;
  }

  private async drive(rec: AgentRecord): Promise<void> {
    if (rec.running) return;
    rec.running = true;
    try {
      while (rec.mailbox.length > 0) {
        // close() may flip status to 'shutdown' between turns.
        if ((rec.status as AgentStatus) === 'shutdown') break;
        const prompt = rec.mailbox.shift() as string;
        rec.lastTaskMessage = prompt;
        rec.status = 'running';
        this.bump();
        try {
          const out = await this.executor({
            agentDef: rec.agentDef,
            history: rec.history,
            prompt,
            model: rec.model,
            agentId: rec.id,
          });
          rec.history = out.history;
          rec.finalMessage = out.text;
          if ((rec.status as AgentStatus) !== 'shutdown') {
            rec.status = { completed: out.text || null };
          }
        } catch (error) {
          rec.status = {
            errored: error instanceof Error ? error.message : String(error),
          };
        }
        this.bump();
      }
    } finally {
      rec.running = false;
    }
  }

  spawn(req: {
    message: string;
    agentType?: string;
    taskName?: string;
    model?: string;
  }):
    | { ok: true; id: string; taskName: string }
    | { ok: false; error: string } {
    const live = [...this.agents.values()].filter(
      (r) => r.status !== 'shutdown',
    ).length;
    if (live >= MAX_CONCURRENT_AGENTS) {
      return {
        ok: false,
        error: `agent limit reached (max ${MAX_CONCURRENT_AGENTS} concurrent); close one first`,
      };
    }
    const type = (req.agentType ?? 'general').trim() || 'general';
    const agentDef = this.resolveAgentDef(type);
    if (!agentDef) {
      return { ok: false, error: `unknown agent_type: '${type}'` };
    }
    const message = req.message.trim();
    if (!message) {
      return { ok: false, error: 'message must be a non-empty string' };
    }
    this.counter += 1;
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const taskName =
      req.taskName?.trim() && /^[a-z0-9_]+$/.test(req.taskName.trim())
        ? req.taskName.trim()
        : `task_${this.counter}`;
    const rec: AgentRecord = {
      id,
      taskName,
      agentDef,
      model: req.model,
      status: 'pending_init',
      running: false,
      mailbox: [message],
      lastTaskMessage: message,
      history: [],
    };
    this.agents.set(id, rec);
    this.bump();
    void this.drive(rec);
    return { ok: true, id, taskName };
  }

  sendInput(req: {
    target: string;
    message: string;
    interrupt?: boolean;
  }): { ok: true; submissionId: string } | { ok: false; error: string } {
    const rec = this.resolve(req.target);
    if (!rec) return { ok: false, error: `agent not found: ${req.target}` };
    if (rec.status === 'shutdown') {
      return { ok: false, error: `agent ${req.target} is shut down` };
    }
    const message = req.message.trim();
    if (!message) return { ok: false, error: 'message must be non-empty' };
    if (req.interrupt) {
      // Cooperative interrupt: jump the queue. We cannot preempt an in-flight
      // model call, so it takes effect after the current turn settles.
      rec.mailbox.unshift(message);
    } else {
      rec.mailbox.push(message);
    }
    const submissionId = `sub-${crypto.randomUUID().slice(0, 8)}`;
    this.bump();
    void this.drive(rec);
    return { ok: true, submissionId };
  }

  async waitV1(
    targets: string[],
    timeoutMs: number,
  ): Promise<{ status: Record<string, AgentStatus>; timed_out: boolean }> {
    const deadline = Date.now() + timeoutMs;
    const recs = targets.map((t) => this.resolve(t));
    while (true) {
      const status: Record<string, AgentStatus> = {};
      let allFinal = true;
      for (let i = 0; i < targets.length; i += 1) {
        const rec = recs[i] ?? this.resolve(targets[i] as string);
        const key = targets[i] as string;
        if (!rec) {
          status[key] = 'not_found';
          continue;
        }
        status[key] = rec.status;
        if (!isFinal(rec.status)) allFinal = false;
      }
      if (allFinal) return { status, timed_out: false };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status, timed_out: true };
      await this.nextChange(Math.min(remaining, 2000));
    }
  }

  async waitV2(
    timeoutMs: number,
  ): Promise<{ message: string; timed_out: boolean }> {
    const snapshot = new Map(
      [...this.agents.values()].map((r) => [
        r.id,
        JSON.stringify(r.status) + r.mailbox.length,
      ]),
    );
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const updated: string[] = [];
      for (const rec of this.agents.values()) {
        const sig = JSON.stringify(rec.status) + rec.mailbox.length;
        if (snapshot.get(rec.id) !== sig) updated.push(rec.taskName);
      }
      if (updated.length > 0) {
        return {
          message: `mailbox update from: ${updated.join(', ')}`,
          timed_out: false,
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { message: 'no mailbox update before timeout', timed_out: true };
      }
      await this.nextChange(Math.min(remaining, 2000));
    }
  }

  close(target: string):
    | { ok: true; previous: AgentStatus }
    | {
        ok: false;
        error: string;
      } {
    const rec = this.resolve(target);
    if (!rec) return { ok: false, error: `agent not found: ${target}` };
    const previous = rec.status;
    rec.status = 'shutdown';
    rec.mailbox = [];
    this.bump();
    return { ok: true, previous };
  }

  list(): Array<{
    agent_name: string;
    agent_status: AgentStatus;
    last_task_message: string | null;
  }> {
    const out = [];
    for (const rec of this.agents.values()) {
      if (rec.status === 'shutdown') continue;
      out.push({
        agent_name: rec.taskName,
        agent_status: rec.status,
        last_task_message: rec.lastTaskMessage ?? null,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

function ok(toolCallId: string, toolName: string, output: unknown): ToolResult {
  return { toolCallId, toolName, output };
}
function fail(
  toolCallId: string,
  toolName: string,
  message: string,
): ToolResult {
  return { toolCallId, toolName, output: message, isError: true };
}

const WAIT_DEFAULT_MS = 60_000;
const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 600_000;

function clampTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : WAIT_DEFAULT_MS;
  return Math.max(WAIT_MIN_MS, Math.min(WAIT_MAX_MS, n));
}

export function createMultiAgentTools(
  manager: AgentManager,
  version: 'v1' | 'v2',
  agentTypes: string[],
): ToolSpec[] {
  const typeList = agentTypes.join(', ');
  const cid = (input: Record<string, unknown>) =>
    String(input.toolCallId ?? crypto.randomUUID());

  const spawnSchema =
    version === 'v2'
      ? z.object({
          task_name: z.string().min(1),
          message: z.string().min(1),
          agent_type: z.string().optional(),
          model: z.string().optional(),
        })
      : z.object({
          message: z.string().min(1),
          agent_type: z.string().optional(),
          model: z.string().optional(),
        });

  const spawnTool: ToolSpec = {
    name: 'spawn_agent',
    description:
      version === 'v2'
        ? `Spawn a sub-agent on a well-scoped task. Provide a task_name (lowercase letters, digits, underscores) and the message. The agent runs in the background with its own context; its final answer is returned when it finishes. Available agent_type: ${typeList}. Only use when the user asked for delegation or parallel agent work.`
        : `Spawn a sub-agent for a well-scoped task. Returns the spawned agent id. The agent runs in the background; use wait_agent to collect its result. Available agent_type: ${typeList}. Only use when the user asked for delegation or parallel agent work.`,
    inputSchema: spawnSchema,
    execute: async (input) => {
      const id = cid(input);
      const res = manager.spawn({
        message: String(input.message ?? ''),
        agentType: input.agent_type ? String(input.agent_type) : undefined,
        taskName: input.task_name ? String(input.task_name) : undefined,
        model: input.model ? String(input.model) : undefined,
      });
      if (!res.ok) return fail(id, 'spawn_agent', res.error);
      return ok(
        id,
        'spawn_agent',
        version === 'v2'
          ? { task_name: res.taskName, nickname: null }
          : { agent_id: res.id, nickname: null },
      );
    },
  };

  const sendInputTool: ToolSpec = {
    name: 'send_input',
    description:
      'Send a message to an existing agent. interrupt=true jumps the queue (takes effect after the current turn settles); otherwise the message is queued. Reuse an agent via send_input when the new task depends on its prior context.',
    inputSchema: z.object({
      target: z.string().min(1),
      message: z.string().min(1),
      interrupt: z.boolean().optional(),
    }),
    execute: async (input) => {
      const id = cid(input);
      const res = manager.sendInput({
        target: String(input.target ?? ''),
        message: String(input.message ?? ''),
        interrupt: input.interrupt === true,
      });
      if (!res.ok) return fail(id, 'send_input', res.error);
      return ok(id, 'send_input', { submission_id: res.submissionId });
    },
  };

  const waitTool: ToolSpec = {
    name: 'wait_agent',
    description:
      version === 'v2'
        ? 'Wait for a mailbox update from any live agent (queued messages or final-status notifications). Returns a summary, not the content, or a timeout summary. Prefer longer waits over busy polling.'
        : 'Wait for the given agents to reach a final status. Returns the per-agent statuses, or empty/timed_out when the deadline passes first. Prefer longer waits over busy polling.',
    inputSchema:
      version === 'v2'
        ? z.object({ timeout_ms: z.number().optional() })
        : z.object({
            targets: z.array(z.string()).min(1),
            timeout_ms: z.number().optional(),
          }),
    execute: async (input) => {
      const id = cid(input);
      const timeout = clampTimeout(input.timeout_ms);
      if (version === 'v2') {
        const res = await manager.waitV2(timeout);
        return ok(id, 'wait_agent', res);
      }
      const targets = Array.isArray(input.targets)
        ? (input.targets as unknown[]).map(String)
        : [];
      if (targets.length === 0) {
        return fail(id, 'wait_agent', 'targets must be a non-empty array');
      }
      const res = await manager.waitV1(targets, timeout);
      return ok(id, 'wait_agent', res);
    },
  };

  const closeTool: ToolSpec = {
    name: 'close_agent',
    description:
      "Close an agent (and stop its queued work) when it is no longer needed. Returns the agent's status before shutdown. Don't keep agents open longer than necessary.",
    inputSchema: z.object({ target: z.string().min(1) }),
    execute: async (input) => {
      const id = cid(input);
      const res = manager.close(String(input.target ?? ''));
      if (!res.ok) return fail(id, 'close_agent', res.error);
      return ok(id, 'close_agent', { previous_status: res.previous });
    },
  };

  const listTool: ToolSpec = {
    name: 'list_agents',
    description:
      'List live agents in this session with their status and most recent instruction.',
    inputSchema: z.object({}),
    execute: async (input) => {
      const id = cid(input);
      return ok(id, 'list_agents', { agents: manager.list() });
    },
  };

  return [spawnTool, sendInputTool, waitTool, closeTool, listTool];
}

export const MULTI_AGENT_TOOL_NAMES = [
  'spawn_agent',
  'send_input',
  'wait_agent',
  'close_agent',
  'list_agents',
] as const;
