import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class WorkspaceEscapeError extends Error {
  readonly userPath: string;
  readonly workspaceRoot: string;
  constructor(workspaceRoot: string, userPath: string) {
    super(
      `path '${userPath}' resolves outside workspace root '${workspaceRoot}'`,
    );
    this.name = 'WorkspaceEscapeError';
    this.userPath = userPath;
    this.workspaceRoot = workspaceRoot;
  }
}

// realpath the deepest existing ancestor; keep the remaining segments verbatim.
// Needed because Write may target a new file (no leaf to realpath), but a parent
// directory could still be a symlink that escapes the workspace.
function realpathPartial(p: string): string {
  const abs = resolve(p);
  const segments = abs.split(sep);
  for (let i = segments.length; i > 0; i -= 1) {
    const candidate = segments.slice(0, i).join(sep) || sep;
    try {
      const real = realpathSync(candidate);
      const tail = segments.slice(i);
      return tail.length > 0 ? resolve(real, ...tail) : real;
    } catch {
      // try a shorter prefix
    }
  }
  return abs;
}

// Confine `userPath` to `workspaceRoot`. Symlinks are resolved BEFORE the
// containment check, so a symlink that lives inside the workspace but targets
// a path outside it is REJECTED. Throws WorkspaceEscapeError on escape.
export function resolveInside(workspaceRoot: string, userPath: string): string {
  const requested = resolve(workspaceRoot, userPath);
  const rootReal = realpathPartial(workspaceRoot);
  const targetReal = realpathPartial(requested);
  const rel = relative(rootReal, targetReal);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return targetReal;
  }
  throw new WorkspaceEscapeError(workspaceRoot, userPath);
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}
