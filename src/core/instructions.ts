import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ProjectInstructionFile, ProjectInstructionSet } from '@/types';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findGitRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);

  while (true) {
    if (await fileExists(join(current, '.git'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolve(startDir);
    }
    current = parent;
  }
}

function collectDirectories(root: string, cwd: string): string[] {
  const dirs: string[] = [];
  let current = resolve(cwd);

  while (true) {
    dirs.unshift(current);
    if (current === root) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

export async function loadProjectInstructions(
  cwd: string,
): Promise<ProjectInstructionSet> {
  const gitRoot = await findGitRoot(cwd);
  const directories = collectDirectories(gitRoot, cwd);
  const files: ProjectInstructionFile[] = [];

  for (const directory of directories) {
    for (const name of ['CLAUDE.md', 'AGENTS.md'] as const) {
      const path = join(directory, name);
      if (await fileExists(path)) {
        files.push({
          kind: name,
          path,
          directory,
          content: await readFile(path, 'utf8'),
        });
      }
    }
  }

  return {
    cwd,
    gitRoot,
    files,
    mergedContent: files
      .map(
        (file) =>
          `# ${file.kind}\nPath: ${file.path}\n\n${file.content.trim()}`,
      )
      .join('\n\n'),
  };
}
