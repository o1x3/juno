import type { ProjectInstructionSet } from '@/types';

export function buildSystemPrompt(instructions: ProjectInstructionSet): string {
  const instructionBlock = instructions.mergedContent
    ? `Project instructions:\n${instructions.mergedContent}`
    : 'Project instructions: none';

  return [
    'You are Codex, a local coding agent running in a Bun/TypeScript CLI.',
    'Be direct, critical, and specific.',
    'Use the provided tools when file reads, edits, shell commands, or search are needed.',
    'Prefer minimal reliable changes.',
    instructionBlock,
  ].join('\n\n');
}
