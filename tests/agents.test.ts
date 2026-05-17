import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILTIN_AGENTS,
  findAgent,
  loadAgents,
  parseAgentFile,
  resolveAgentTools,
} from '@/core/agents';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

const ALL_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'apply_patch',
  'Bash',
  'Grep',
  'Glob',
  'LS',
  'TodoWrite',
  'AskUserQuestion',
  'Task',
  'WebFetch',
  'WebSearch',
];

describe('built-in agents', () => {
  test('general and explore exist', () => {
    expect(BUILTIN_AGENTS.map((a) => a.name).sort()).toEqual([
      'explore',
      'general',
    ]);
  });

  test('general gets every tool except Task and TodoWrite', () => {
    const general = findAgent(BUILTIN_AGENTS, 'general');
    if (!general) throw new Error('general agent missing');
    const tools = resolveAgentTools(general, ALL_TOOLS);
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('TodoWrite');
    expect(tools).toContain('Write');
    expect(tools).toContain('apply_patch');
  });

  test('explore is read-only and never gets Task', () => {
    const explore = findAgent(BUILTIN_AGENTS, 'explore');
    if (!explore) throw new Error('explore agent missing');
    const tools = resolveAgentTools(explore, ALL_TOOLS);
    expect(tools.sort()).toEqual([
      'Bash',
      'Glob',
      'Grep',
      'LS',
      'Read',
      'WebFetch',
      'WebSearch',
    ]);
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Task');
  });
});

describe('parseAgentFile', () => {
  test('parses frontmatter + body', () => {
    const def = parseAgentFile(
      'reviewer',
      [
        '---',
        'name: code-reviewer',
        'description: Reviews code for bugs',
        'model: gpt-5.4',
        'tools: Read, Grep, Glob',
        '---',
        'You are a meticulous code reviewer.',
        'Be terse.',
      ].join('\n'),
    );
    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('Reviews code for bugs');
    expect(def.model).toBe('gpt-5.4');
    expect(def.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(def.prompt).toBe('You are a meticulous code reviewer.\nBe terse.');
    expect(def.source).toBe('project');
  });

  test('falls back to filename when no name key', () => {
    const def = parseAgentFile('helper', 'No frontmatter here, just a prompt.');
    expect(def.name).toBe('helper');
    expect(def.tools).toBeUndefined();
    expect(def.prompt).toBe('No frontmatter here, just a prompt.');
  });

  test('quoted values are unwrapped', () => {
    const def = parseAgentFile(
      'x',
      '---\ndescription: "quoted desc"\n---\nbody',
    );
    expect(def.description).toBe('quoted desc');
  });
});

describe('loadAgents discovery', () => {
  test('project agent files override built-ins; .juno wins over .claude', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-agents-'));
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(join(workspace, '.claude', 'agents'), { recursive: true });
    await mkdir(join(workspace, '.juno', 'agents'), { recursive: true });

    await writeFile(
      join(workspace, '.claude', 'agents', 'general.md'),
      '---\ndescription: claude override\n---\nclaude general prompt',
    );
    await writeFile(
      join(workspace, '.juno', 'agents', 'general.md'),
      '---\ndescription: juno override\n---\njuno general prompt',
    );
    await writeFile(
      join(workspace, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: a reviewer\ntools: Read\n---\nreview prompt',
    );

    const agents = await loadAgents(workspace);
    const general = findAgent(agents, 'general');
    // .juno wins over .claude wins over built-in.
    expect(general?.description).toBe('juno override');
    expect(general?.prompt).toBe('juno general prompt');

    const reviewer = findAgent(agents, 'reviewer');
    expect(reviewer?.description).toBe('a reviewer');
    expect(reviewer?.tools).toEqual(['Read']);

    // explore built-in survives when not overridden.
    expect(findAgent(agents, 'explore')).toBeDefined();
  });

  test('no project dirs → just built-ins', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-agents-empty-'));
    await mkdir(join(workspace, '.git'), { recursive: true });
    const agents = await loadAgents(workspace);
    expect(agents.map((a) => a.name).sort()).toEqual(['explore', 'general']);
  });
});
