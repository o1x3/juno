import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { findGitRoot } from '@/core/instructions';

// A loadable skill: a SKILL.md plus the directory of resources beside it.
// Mirrors opencode's Skill model + the SKILL.md open standard referenced in the
// build guide (`.claude/skills/*/SKILL.md`, `.codex/skills/*/SKILL.md`).
export type SkillDefinition = {
  name: string;
  description: string;
  content: string;
  dir: string;
  source: 'project' | 'global';
};

export function parseSkillFile(
  fallbackName: string,
  content: string,
): { name: string; description: string; body: string } {
  let name = fallbackName;
  let description = '';
  let body = content;
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fm) {
    body = content.slice(fm[0].length);
    for (const rawLine of (fm[1] ?? '').split('\n')) {
      const line = rawLine.trim();
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
    }
  }
  return { name, description, body: body.trim() };
}

// Skill container dirs (each holds `<skill>/SKILL.md`). `.codex/skills` and
// `.claude/skills` are read for cross-tool compatibility; `.juno/skills` wins.
const SKILL_CONTAINERS = [
  ['.opencode', 'skill'],
  ['.opencode', 'skills'],
  ['.codex', 'skills'],
  ['.claude', 'skills'],
  ['.juno', 'skills'],
] as const;

async function readSkillContainer(
  containerDir: string,
  source: SkillDefinition['source'],
): Promise<SkillDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(containerDir);
  } catch {
    return [];
  }
  const out: SkillDefinition[] = [];
  for (const entry of entries) {
    const skillDir = join(containerDir, entry);
    try {
      const info = await stat(skillDir);
      if (!info.isDirectory()) continue;
      const mdPath = join(skillDir, 'SKILL.md');
      const content = await readFile(mdPath, 'utf8');
      const parsed = parseSkillFile(entry, content);
      out.push({
        name: parsed.name,
        description: parsed.description,
        content: parsed.body,
        dir: skillDir,
        source,
      });
    } catch {
      // no SKILL.md / unreadable → not a skill dir
    }
  }
  return out;
}

/**
 * Resolve the skill registry: project skills discovered between the git root
 * and cwd, plus global skills under `${homeDir}/skills`. Later sources win by
 * name (project over global; nearer dir over farther; `.juno` over others).
 */
export async function loadSkills(
  cwd: string,
  homeDir?: string,
): Promise<SkillDefinition[]> {
  const registry = new Map<string, SkillDefinition>();

  if (homeDir) {
    for (const s of await readSkillContainer(
      join(homeDir, 'skills'),
      'global',
    )) {
      registry.set(s.name, s);
    }
  }

  const root = await findGitRoot(cwd);
  const dirs: string[] = [];
  let current = resolve(cwd);
  while (true) {
    dirs.unshift(current);
    if (current === root) break;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  for (const dir of dirs) {
    for (const [a, b] of SKILL_CONTAINERS) {
      for (const s of await readSkillContainer(join(dir, a, b), 'project')) {
        registry.set(s.name, s);
      }
    }
  }

  return [...registry.values()];
}

export function findSkill(
  skills: SkillDefinition[],
  name: string,
): SkillDefinition | undefined {
  return skills.find((s) => s.name === name);
}

// List up to `limit` resource files under a skill dir (recursively), excluding
// SKILL.md and dot-dirs. Workspace-relative-ish absolute paths, deterministic.
export async function listSkillFiles(
  skillDir: string,
  limit = 10,
): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (found.length >= limit) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (found.length >= limit) return;
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
      } else if (name !== 'SKILL.md') {
        found.push(full);
      }
    }
  }
  await walk(skillDir);
  return found.slice(0, limit);
}
