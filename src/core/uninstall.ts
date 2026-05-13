import {
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PATH_BLOCK_START = '# >>> juno install >>>';
export const PATH_BLOCK_END = '# <<< juno install <<<';

export const SHELL_RC_CANDIDATES = [
  '.zshenv',
  '.zshrc',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.config/fish/conf.d/juno.fish',
];

export type UninstallPlan = {
  execPath: string;
  homeDir?: string;
};

export type UninstallResult = {
  removed: string[];
  missing: string[];
};

export async function performUninstall(
  plan: UninstallPlan,
): Promise<UninstallResult> {
  const removed: string[] = [];
  const missing: string[] = [];

  const tryRemoveFile = (p: string) => {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed.push(p);
      } catch {
        missing.push(p);
      }
    } else {
      missing.push(p);
    }
  };

  const tryRemoveDir = (p: string) => {
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } else {
      missing.push(p);
    }
  };

  // Order matters: keep the running process's binary alive until after JUNO_HOME
  // is cleared, so any failure mid-purge can still be observed.
  if (plan.homeDir) {
    tryRemoveDir(plan.homeDir);
  }
  tryRemoveFile(`${plan.execPath}.old`);
  tryRemoveFile(plan.execPath);

  return { removed, missing };
}

export function stripPathBlock(content: string): {
  next: string;
  changed: boolean;
} {
  const startIndex = content.indexOf(PATH_BLOCK_START);
  if (startIndex === -1) return { next: content, changed: false };
  const endIndex = content.indexOf(PATH_BLOCK_END, startIndex);
  if (endIndex === -1) return { next: content, changed: false };
  const after = endIndex + PATH_BLOCK_END.length;
  // Eat one trailing newline if present so we don't leave an empty line.
  const trailing = content[after] === '\n' ? 1 : 0;
  // Eat one leading newline immediately before the block so the file doesn't
  // accumulate empty lines after repeated install/uninstall cycles.
  const leading = startIndex > 0 && content[startIndex - 1] === '\n' ? 1 : 0;
  const next =
    content.slice(0, startIndex - leading) + content.slice(after + trailing);
  return { next, changed: true };
}

export function removePathBlockFromShellRcs(options: {
  dryRun: boolean;
  home?: string;
  files?: string[];
}): string[] {
  const home = options.home ?? homedir();
  const files = options.files ?? SHELL_RC_CANDIDATES.map((p) => join(home, p));
  const edited: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { next, changed } = stripPathBlock(content);
    if (!changed) continue;
    edited.push(file);
    if (!options.dryRun) {
      try {
        writeFileSync(file, next);
      } catch {
        // best-effort; keep iterating
      }
    }
  }
  return edited;
}
