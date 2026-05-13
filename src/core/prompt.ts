import type { AgentMode, ProjectInstructionSet } from '@/types';

const PLAN_PREAMBLE = [
  'PLAN MODE.',
  'You can only call Read, Grep, Glob, LS, and TodoWrite. Edit, Write, and Bash are unavailable this turn.',
  'Do not propose tool calls that modify the workspace or run commands.',
  'Read enough to understand the change, then end with a numbered plan and an explicit handoff line: "Switch to exec mode (Shift+Tab) to execute."',
].join(' ');

export function buildSystemPrompt(
  instructions: ProjectInstructionSet,
  mode: AgentMode = 'exec',
): string {
  const instructionBlock = instructions.mergedContent
    ? `Project instructions:\n${instructions.mergedContent}`
    : 'Project instructions: none';

  const sections = [
    'You are Juno, a local coding agent running in a Bun/TypeScript CLI.',
    'Be direct, critical, and specific.',
    'Use the provided tools when file reads, edits, shell commands, or search are needed.',
    'Prefer minimal reliable changes.',
    'Use TodoWrite to track a multi-step plan when the work spans several tool calls or files. Pass the full list on every call (replace semantics); keep at most one item in_progress.',
  ];

  if (mode === 'plan') {
    sections.push(PLAN_PREAMBLE);
  }

  sections.push(instructionBlock);
  return sections.join('\n\n');
}
