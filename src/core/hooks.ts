// Lifecycle hooks: PreToolUse / PostToolUse / UserPromptSubmit / Stop.
//
// Contract mirrors Claude Code so existing hook scripts are portable: each
// hook is a shell command, it receives a JSON event on stdin, and it steers
// the agent via exit code or a JSON object on stdout.
//
//   exit 0            → allow; JSON stdout may add context / decisions
//   exit 2            → block; stderr is the reason fed back to the model
//   other non-zero    → non-blocking error (logged, ignored)
//
// JSON stdout (any subset):
//   { "decision": "block", "reason": "...",
//     "hookSpecificOutput": { "permissionDecision": "allow"|"deny"|"ask",
//                             "permissionDecisionReason": "...",
//                             "additionalContext": "..." } }
//
// No hooks configured → a no-op runner with zero overhead and zero behaviour
// change.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hookConfigSchema } from '@/core/config';
import type { HookConfig, HookEvent, HookMatcher } from '@/types';

export type HookDecision = {
  block: boolean;
  reason?: string;
  additionalContext?: string;
};

export type ToolResponseLike = {
  output: unknown;
  isError?: boolean;
};

export type HookRunner = {
  readonly active: boolean;
  preToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<HookDecision>;
  postToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: ToolResponseLike,
  ): Promise<HookDecision>;
  userPromptSubmit(prompt: string): Promise<HookDecision>;
  stop(): Promise<HookDecision>;
};

type SpawnResult = { code: number; stdout: string; stderr: string };
export type HookSpawn = (
  command: string,
  stdin: string,
  cwd: string,
  timeoutMs: number,
) => Promise<SpawnResult>;

const NOOP: HookDecision = { block: false };

function mergeHookConfig(a: HookConfig, b: HookConfig): HookConfig {
  const out: HookConfig = {};
  const events: HookEvent[] = [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
  ];
  for (const ev of events) {
    const merged = [...(a[ev] ?? []), ...(b[ev] ?? [])];
    if (merged.length > 0) out[ev] = merged;
  }
  return out;
}

function readHookFile(path: string): HookConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    // A project file may be `{ hooks: {...} }` or the hook map directly.
    const candidate =
      parsed && typeof parsed === 'object' && 'hooks' in parsed
        ? (parsed as { hooks: unknown }).hooks
        : parsed;
    const result = hookConfigSchema.safeParse(candidate);
    return result.success ? (result.data as HookConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the effective hook config: global `~/.juno/config.json` `hooks`
 * merged with a project `<cwd>/.juno/hooks.json` (project hooks run after
 * global ones). `JUNO_DISABLE_HOOKS` short-circuits to nothing.
 */
export function loadHooks(opts: {
  configFile: string;
  cwd: string;
  globalHooks?: HookConfig;
}): HookConfig {
  if (process.env.JUNO_DISABLE_HOOKS) return {};
  const global = opts.globalHooks ?? readHookFile(opts.configFile);
  const project = readHookFile(join(opts.cwd, '.juno', 'hooks.json'));
  return mergeHookConfig(global, project);
}

const defaultSpawn: HookSpawn = async (command, stdin, cwd, timeoutMs) => {
  try {
    const proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

function matcherApplies(
  event: HookEvent,
  matcher: HookMatcher,
  toolName: string,
): boolean {
  if (event === 'UserPromptSubmit' || event === 'Stop') return true;
  const pattern = matcher.matcher?.trim();
  if (!pattern || pattern === '*') return true;
  try {
    return new RegExp(pattern).test(toolName);
  } catch {
    // Treat an invalid regex as a literal match.
    return pattern === toolName;
  }
}

function interpret(res: SpawnResult, event: HookEvent): HookDecision {
  // exit 2 = hard block, stderr is the reason.
  if (res.code === 2) {
    return {
      block: true,
      reason: res.stderr.trim() || `${event} hook blocked the action`,
    };
  }

  let parsed: Record<string, unknown> | undefined;
  const trimmed = res.stdout.trim();
  if (trimmed.startsWith('{')) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parsed = undefined;
    }
  }

  if (parsed) {
    const hso = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const permission = hso.permissionDecision as string | undefined;
    const decision = parsed.decision as string | undefined;
    const reason =
      (parsed.reason as string | undefined) ??
      (hso.permissionDecisionReason as string | undefined);
    const additionalContext =
      (hso.additionalContext as string | undefined) ??
      (typeof parsed.additionalContext === 'string'
        ? (parsed.additionalContext as string)
        : undefined);

    if (decision === 'block' || permission === 'deny') {
      return {
        block: true,
        reason: reason ?? `${event} hook blocked the action`,
        additionalContext,
      };
    }
    return { block: false, additionalContext };
  }

  // Non-zero (and not 2) → non-blocking soft error. Exit 0 plain stdout on
  // UserPromptSubmit is treated as additional context (Claude Code behaviour).
  if (res.code === 0 && event === 'UserPromptSubmit' && trimmed.length > 0) {
    return { block: false, additionalContext: trimmed };
  }
  return NOOP;
}

export function createHookRunner(opts: {
  hooks: HookConfig;
  sessionId: string;
  cwd: string;
  spawn?: HookSpawn;
}): HookRunner {
  const { hooks, sessionId, cwd } = opts;
  const spawn = opts.spawn ?? defaultSpawn;
  const active = Object.values(hooks).some(
    (list) => Array.isArray(list) && list.length > 0,
  );

  async function run(
    event: HookEvent,
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<HookDecision> {
    const matchers = hooks[event];
    if (!matchers || matchers.length === 0) return NOOP;
    const stdin = JSON.stringify({
      session_id: sessionId,
      cwd,
      hook_event_name: event,
      ...payload,
    });
    const contexts: string[] = [];
    for (const matcher of matchers) {
      if (!matcherApplies(event, matcher, toolName)) continue;
      for (const hook of matcher.hooks) {
        const res = await spawn(
          hook.command,
          stdin,
          cwd,
          (hook.timeout ?? 60) * 1000,
        );
        const decision = interpret(res, event);
        if (decision.additionalContext) {
          contexts.push(decision.additionalContext);
        }
        if (decision.block) {
          return {
            block: true,
            reason: decision.reason,
            additionalContext:
              contexts.length > 0 ? contexts.join('\n') : undefined,
          };
        }
      }
    }
    return {
      block: false,
      additionalContext: contexts.length > 0 ? contexts.join('\n') : undefined,
    };
  }

  return {
    active,
    preToolUse: (toolName, toolInput) =>
      run('PreToolUse', toolName, {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    postToolUse: (toolName, toolInput, toolResponse) =>
      run('PostToolUse', toolName, {
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
      }),
    userPromptSubmit: (prompt) => run('UserPromptSubmit', '', { prompt }),
    stop: () => run('Stop', '', {}),
  };
}

export function noopHookRunner(): HookRunner {
  return {
    active: false,
    preToolUse: async () => NOOP,
    postToolUse: async () => NOOP,
    userPromptSubmit: async () => NOOP,
    stop: async () => NOOP,
  };
}
