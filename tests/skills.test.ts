import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findSkill,
  listSkillFiles,
  loadSkills,
  parseSkillFile,
} from '@/core/skills';
import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolSpec } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('parseSkillFile', () => {
  test('parses frontmatter name/description + body', () => {
    const r = parseSkillFile(
      'dir-name',
      '---\nname: pdf-fill\ndescription: Fill PDF forms\n---\nStep 1. Do the thing.',
    );
    expect(r.name).toBe('pdf-fill');
    expect(r.description).toBe('Fill PDF forms');
    expect(r.body).toBe('Step 1. Do the thing.');
  });

  test('falls back to dir name without frontmatter', () => {
    const r = parseSkillFile('helper', 'just a body');
    expect(r.name).toBe('helper');
    expect(r.body).toBe('just a body');
  });
});

describe('loadSkills discovery', () => {
  test('discovers .claude/.codex/.juno skills; .juno wins, project over global', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sk-'));
    await mkdir(join(workspace, '.git'));
    const home = await mkdtemp(join(tmpdir(), 'juno-sk-home-'));

    await mkdir(join(workspace, '.claude', 'skills', 'review'), {
      recursive: true,
    });
    await writeFile(
      join(workspace, '.claude', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: claude review\n---\nclaude body',
    );
    await mkdir(join(workspace, '.juno', 'skills', 'review'), {
      recursive: true,
    });
    await writeFile(
      join(workspace, '.juno', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: juno review\n---\njuno body',
    );
    await mkdir(join(workspace, '.codex', 'skills', 'fmt'), {
      recursive: true,
    });
    await writeFile(
      join(workspace, '.codex', 'skills', 'fmt', 'SKILL.md'),
      '---\nname: fmt\ndescription: formatter\n---\nfmt body',
    );
    await mkdir(join(home, 'skills', 'globalskill'), { recursive: true });
    await writeFile(
      join(home, 'skills', 'globalskill', 'SKILL.md'),
      '---\nname: globalskill\ndescription: from home\n---\ng',
    );

    const skills = await loadSkills(workspace, home);
    const review = findSkill(skills, 'review');
    expect(review?.description).toBe('juno review');
    expect(review?.content).toBe('juno body');
    expect(findSkill(skills, 'fmt')?.description).toBe('formatter');
    expect(findSkill(skills, 'globalskill')?.source).toBe('global');
    await rm(home, { recursive: true, force: true });
  });

  test('no skill dirs → empty registry', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sk-empty-'));
    await mkdir(join(workspace, '.git'));
    expect(await loadSkills(workspace)).toEqual([]);
  });
});

describe('listSkillFiles', () => {
  test('lists resource files, excludes SKILL.md and dotfiles, caps at limit', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sk-files-'));
    const dir = join(workspace, 'skill');
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), 'x');
    await writeFile(join(dir, 'scripts', 'run.sh'), 'x');
    await writeFile(join(dir, 'reference.md'), 'x');
    await writeFile(join(dir, '.hidden'), 'x');
    const files = await listSkillFiles(dir, 10);
    expect(files.some((f) => f.endsWith('SKILL.md'))).toBe(false);
    expect(files.some((f) => f.endsWith('.hidden'))).toBe(false);
    expect(files.some((f) => f.endsWith('run.sh'))).toBe(true);
    expect(files.some((f) => f.endsWith('reference.md'))).toBe(true);
  });
});

function ctx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 50_000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

describe('Skill tool', () => {
  test('not registered when there are no skills', () => {
    const names = createBuiltinTools(
      {
        cwd: '/tmp',
        outputLimit: 1,
        readLineLimit: 1,
        bashTimeoutMs: 1,
        sessionsDir: '/tmp',
        sessionId: 't',
      },
      {},
    ).map((t) => t.name);
    expect(names).not.toContain('Skill');
  });

  test('loads skill content + sampled file list', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sk-tool-'));
    const skills = [
      {
        name: 'deploy',
        description: 'Deploy the app',
        content: 'Run the deploy steps.',
        dir: join(workspace, 'sk'),
        source: 'project' as const,
      },
    ];
    await mkdir(join(workspace, 'sk'));
    await writeFile(join(workspace, 'sk', 'SKILL.md'), 'x');
    await writeFile(join(workspace, 'sk', 'deploy.sh'), 'echo go');

    const tool = createBuiltinTools(ctx(), { skills }).find(
      (t) => t.name === 'Skill',
    ) as ToolSpec;
    expect(tool).toBeDefined();
    expect(tool.description).toContain('"deploy": Deploy the app');

    const r = await tool.execute({ name: 'deploy', toolCallId: '1' }, ctx());
    expect(r.isError).toBeUndefined();
    const o = r.output as { name: string; content: string; fileCount: number };
    expect(o.name).toBe('deploy');
    expect(o.content).toContain('<skill_content name="deploy">');
    expect(o.content).toContain('Run the deploy steps.');
    expect(o.content).toContain('deploy.sh');
    expect(o.fileCount).toBe(1);
  });

  test('unknown skill lists available', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-sk-unk-'));
    const skills = [
      {
        name: 'a',
        description: '',
        content: '',
        dir: workspace,
        source: 'project' as const,
      },
    ];
    const tool = createBuiltinTools(ctx(), { skills }).find(
      (t) => t.name === 'Skill',
    ) as ToolSpec;
    const r = await tool.execute({ name: 'zzz', toolCallId: '1' }, ctx());
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('not found');
    expect(String(r.output)).toContain('Available skills: a');
  });
});
