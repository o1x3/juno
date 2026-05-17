import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { findGitRoot } from '@/core/instructions';
import type { BuiltinToolName } from '@/types';

// A sub-agent definition. `tools` is an allowlist of built-in tool names; when
// undefined the agent gets every built-in tool. `Task` is always stripped from
// the resolved set so sub-agents cannot recurse (Claude Code's "one branch
// deep" nO constraint).
export type AgentDefinition = {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  source: 'builtin' | 'project';
};

const GENERAL_PROMPT = [
  'You are a general-purpose sub-agent dispatched by the main Juno agent.',
  'You run autonomously in your own context with no memory of the parent conversation beyond the task prompt you were given.',
  '',
  'Carry the task through to a concrete outcome: gather context with your tools, make the requested changes, and verify them.',
  'Be surgical and minimal. Ground claims in evidence from the tools, not assumption.',
  'Your final message is the ONLY thing returned to the caller — make it a concise, self-contained summary of what you did and what you found. State file paths and concrete results, not narration.',
].join('\n');

// Ported from ref/opencode/packages/opencode/src/agent/prompt/explore.txt.
const EXPLORE_PROMPT = [
  'You are a file search specialist. You excel at thoroughly navigating and exploring codebases.',
  '',
  'Your strengths:',
  '- Rapidly finding files using glob patterns',
  '- Searching code and text with powerful regex patterns',
  '- Reading and analyzing file contents',
  '',
  'Guidelines:',
  '- Use Glob for broad file pattern matching',
  '- Use Grep for searching file contents with regex',
  '- Use Read when you know the specific file path you need to read',
  '- Use Bash for read-only file operations like listing directory contents',
  '- Adapt your search approach based on the thoroughness level specified by the caller',
  '- Return file paths as workspace-relative or absolute paths in your final response',
  '- For clear communication, avoid using emojis',
  "- Do not create any files, or run bash commands that modify the user's system state in any way",
  '',
  "Complete the user's search request efficiently and report your findings clearly.",
].join('\n');

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'general',
    description:
      'General-purpose agent for researching complex questions and executing multi-step tasks autonomously. Use when a task needs its own focused context or can run in parallel with other work.',
    prompt: GENERAL_PROMPT,
    // No `tools` allowlist → every built-in except Task (stripped below).
    // Mirrors opencode's `general` which also denies TodoWrite (the parent owns
    // the plan); enforced in resolveAgentTools.
    source: 'builtin',
  },
  {
    name: 'explore',
    description:
      'Fast read-only agent specialized for exploring codebases. Use it to find files by pattern, search code for keywords, or answer questions about the codebase. Specify the desired thoroughness: "quick", "medium", or "very thorough".',
    prompt: EXPLORE_PROMPT,
    tools: ['Read', 'Grep', 'Glob', 'LS', 'Bash', 'WebFetch', 'WebSearch'],
    source: 'builtin',
  },
];

// Sub-agents never get Task (no recursion). `general` additionally drops
// TodoWrite — the parent agent owns the plan.
function denylistForAgent(name: string): Set<string> {
  const deny = new Set<string>(['Task']);
  if (name === 'general') deny.add('TodoWrite');
  return deny;
}

export function resolveAgentTools(
  def: AgentDefinition,
  available: string[],
): string[] {
  const deny = denylistForAgent(def.name);
  const allowlist = def.tools;
  return available.filter((t) => {
    if (deny.has(t)) return false;
    if (allowlist && !allowlist.includes(t)) return false;
    return true;
  });
}

// Minimal frontmatter parser (no YAML dependency). Recognizes a leading
// `---\n ... \n---\n` block of `key: value` lines; the remainder is the prompt
// body. `tools` accepts a comma- or whitespace-separated list.
export function parseAgentFile(
  fallbackName: string,
  content: string,
): AgentDefinition {
  let name = fallbackName;
  let description = '';
  let model: string | undefined;
  let tools: string[] | undefined;
  let body = content;

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    body = content.slice(fmMatch[0].length);
    for (const rawLine of (fmMatch[1] ?? '').split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === 'name' && value) name = value;
      else if (key === 'description') description = value;
      else if (key === 'model' && value) model = value;
      else if (key === 'tools' && value) {
        tools = value
          .split(/[,\s]+/)
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }
    }
  }

  return {
    name,
    description,
    prompt: body.trim(),
    tools,
    model,
    source: 'project',
  };
}

// Project agent directories, in precedence order (later wins). `.opencode/agent`
// and `.claude/agents` are read for cross-tool compatibility (the AGENTS.md /
// sub-agent standard); `.juno/agents` is Juno's own and wins.
const AGENT_DIRS = [
  ['.opencode', 'agent'],
  ['.claude', 'agents'],
  ['.juno', 'agents'],
] as const;

async function readAgentDir(dir: string): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const fallbackName = entry.slice(0, -3);
    try {
      const content = await readFile(join(dir, entry), 'utf8');
      out.push(parseAgentFile(fallbackName, content));
    } catch {
      // skip unreadable agent files
    }
  }
  return out;
}

/**
 * Resolve the full agent registry for a workspace: built-ins plus any project
 * agent files discovered between the git root and cwd. Later sources override
 * earlier ones by name (project overrides built-in; nearer dir overrides
 * farther; `.juno` overrides `.claude`/`.opencode`).
 */
export async function loadAgents(cwd: string): Promise<AgentDefinition[]> {
  const registry = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN_AGENTS) registry.set(agent.name, agent);

  const root = await findGitRoot(cwd);
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.unshift(current);
    if (current === root) break;
    const parent = join(current, '..');
    const resolvedParent = resolve(parent);
    if (resolvedParent === current) break;
    current = resolvedParent;
  }

  for (const dir of dirs) {
    for (const [a, b] of AGENT_DIRS) {
      for (const def of await readAgentDir(join(dir, a, b))) {
        if (def.name) registry.set(def.name, def);
      }
    }
  }

  return [...registry.values()];
}

export function findAgent(
  agents: AgentDefinition[],
  name: string,
): AgentDefinition | undefined {
  return agents.find((a) => a.name === name);
}

export type { BuiltinToolName };
