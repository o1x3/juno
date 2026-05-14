import { realpathSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { computeLineDiff } from '@/core/diff';
import { ensureParent, resolveInside, truncateText } from '@/core/fs';
import { appendSessionEvent } from '@/core/session-store';
import type {
  TodoItem,
  TodoStatus,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '@/types';

const GLOB_RESULT_LIMIT = 1000;
const LS_RESULT_LIMIT = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.claude']);

function relativeToRoot(root: string, target: string): string {
  // resolveInside returns a realpath'd target, so we have to realpath the root
  // too — otherwise /tmp/foo vs /private/tmp/foo on macOS produces a spurious
  // `..`-prefixed relative path.
  let rootResolved = resolve(root);
  try {
    rootResolved = realpathSync(rootResolved);
  } catch {
    // root doesn't exist; fall back to the resolved (non-real) path
  }
  const rel = relative(rootResolved, resolve(target));
  return rel === '' ? '.' : rel;
}

function hasSkippedSegment(relPath: string): boolean {
  for (const segment of relPath.split('/')) {
    if (SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export type ShellOptions = {
  cwd: string;
  timeoutMs?: number;
  outputLimit?: number;
  signal?: AbortSignal;
};

export async function executeShellCommand(
  command: string,
  options: ShellOptions,
): Promise<ShellResult> {
  const processHandle = Bun.spawn({
    cmd: ['bash', '-lc', command],
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      processHandle.kill();
    }, options.timeoutMs);
  }

  const onAbort = () => {
    timedOut = false;
    processHandle.kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);

    return {
      stdout:
        options.outputLimit !== undefined
          ? truncateText(stdout, options.outputLimit)
          : stdout,
      stderr:
        options.outputLimit !== undefined
          ? truncateText(stderr, options.outputLimit)
          : stderr,
      exitCode,
      timedOut,
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function ok(
  toolCallId: string,
  toolName: ToolResult['toolName'],
  output: unknown,
): ToolResult {
  return { toolCallId, toolName, output };
}

function fail(
  toolCallId: string,
  toolName: ToolResult['toolName'],
  message: string,
): ToolResult {
  return { toolCallId, toolName, output: message, isError: true };
}

export function createBuiltinTools(context: ToolContext): ToolSpec[] {
  return [
    {
      name: 'Read',
      description:
        'Read a file from the workspace. Supports optional start and end lines.',
      inputSchema: z.object({
        filePath: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const path = resolveInside(context.cwd, String(input.filePath));
          const file = await readFile(path, 'utf8');
          const lines = file.split('\n');
          const startLine = Number(input.startLine ?? 1);
          const endLine = Number(
            input.endLine ??
              Math.min(lines.length, startLine + context.readLineLimit - 1),
          );
          const slice = lines.slice(startLine - 1, endLine);
          return ok(toolCallId, 'Read', {
            path,
            startLine,
            endLine,
            content: truncateText(slice.join('\n'), context.outputLimit),
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Read',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'Write',
      description:
        'Write the full contents of a file. Creates parent directories if needed.',
      inputSchema: z.object({
        filePath: z.string(),
        content: z.string(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const path = resolveInside(context.cwd, String(input.filePath));
          await ensureParent(path);
          const nextContent = String(input.content);
          let oldContent = '';
          let created = false;
          try {
            oldContent = await readFile(path, 'utf8');
          } catch (readError) {
            if (
              readError instanceof Error &&
              (readError as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
              created = true;
            } else {
              throw readError;
            }
          }
          await writeFile(path, nextContent, 'utf8');
          const diff = computeLineDiff(oldContent, nextContent);
          if (created) diff.created = true;
          return ok(toolCallId, 'Write', {
            path,
            bytes: nextContent.length,
            created,
            diff,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Write',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'Edit',
      description:
        'Replace an exact string in a file. Fails if the match is missing or ambiguous.',
      inputSchema: z.object({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const path = resolveInside(context.cwd, String(input.filePath));
          const content = await readFile(path, 'utf8');
          const oldString = String(input.oldString);
          const matches = content.split(oldString).length - 1;
          if (matches === 0) {
            return fail(toolCallId, 'Edit', `No match found in ${path}`);
          }
          if (matches > 1) {
            return fail(
              toolCallId,
              'Edit',
              `Ambiguous match in ${path}: found ${matches} occurrences`,
            );
          }
          const next = content.replace(oldString, String(input.newString));
          await writeFile(path, next, 'utf8');
          const diff = computeLineDiff(content, next);
          return ok(toolCallId, 'Edit', { path, replaced: true, diff });
        } catch (error) {
          return fail(
            toolCallId,
            'Edit',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      // Bash deliberately bypasses resolveInside: the command runs arbitrary
      // shell in `context.cwd`, so a workspace-confinement check would be
      // theatre. Containment for Bash is the operator's responsibility.
      name: 'Bash',
      description:
        'Run a shell command inside the workspace with bounded output and a timeout.',
      inputSchema: z.object({
        command: z.string(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const result = await executeShellCommand(String(input.command), {
            cwd: context.cwd,
            timeoutMs: context.bashTimeoutMs,
            outputLimit: context.outputLimit,
          });
          return ok(toolCallId, 'Bash', {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Bash',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'TodoWrite',
      description:
        'Replace the in-session plan. Pass the full list every call. Use for multi-step work; keep at most one item in_progress.',
      inputSchema: z.object({
        todos: z.array(
          z.object({
            id: z.string().min(1),
            content: z.string().min(1),
            status: z.enum(['pending', 'in_progress', 'completed']),
            activeForm: z.string().optional(),
          }),
        ),
      }),
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const raw = input.todos;
          if (!Array.isArray(raw)) {
            return fail(toolCallId, 'TodoWrite', '`todos` must be an array');
          }
          const todos: TodoItem[] = [];
          const seenIds = new Set<string>();
          for (let i = 0; i < raw.length; i += 1) {
            const item = raw[i] as Record<string, unknown> | undefined;
            if (!item || typeof item !== 'object') {
              return fail(
                toolCallId,
                'TodoWrite',
                `todos[${i}] must be an object`,
              );
            }
            const id = item.id;
            const content = item.content;
            const status = item.status;
            if (typeof id !== 'string' || id.length === 0) {
              return fail(
                toolCallId,
                'TodoWrite',
                `todos[${i}].id must be a non-empty string`,
              );
            }
            if (typeof content !== 'string' || content.length === 0) {
              return fail(
                toolCallId,
                'TodoWrite',
                `todos[${i}].content must be a non-empty string`,
              );
            }
            if (
              status !== 'pending' &&
              status !== 'in_progress' &&
              status !== 'completed'
            ) {
              return fail(
                toolCallId,
                'TodoWrite',
                `todos[${i}].status must be pending|in_progress|completed`,
              );
            }
            if (seenIds.has(id)) {
              return fail(toolCallId, 'TodoWrite', `duplicate todo id: ${id}`);
            }
            seenIds.add(id);
            const activeForm = item.activeForm;
            if (activeForm !== undefined && typeof activeForm !== 'string') {
              return fail(
                toolCallId,
                'TodoWrite',
                `todos[${i}].activeForm must be a string when present`,
              );
            }
            todos.push({
              id,
              content,
              status: status as TodoStatus,
              ...(activeForm !== undefined ? { activeForm } : {}),
            });
          }
          const inProgress = todos.filter(
            (t) => t.status === 'in_progress',
          ).length;
          if (inProgress > 1) {
            return fail(
              toolCallId,
              'TodoWrite',
              `at most one todo may be in_progress (got ${inProgress})`,
            );
          }
          await appendSessionEvent(
            runtimeContext.sessionsDir,
            runtimeContext.sessionId,
            {
              type: 'todo_update',
              timestamp: new Date().toISOString(),
              todos,
            },
          );
          return ok(toolCallId, 'TodoWrite', { todos });
        } catch (error) {
          return fail(
            toolCallId,
            'TodoWrite',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'Grep',
      description:
        'Search the workspace with ripgrep and return bounded output.',
      inputSchema: z.object({
        pattern: z.string(),
        glob: z.string().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const args = [
            'rg',
            '--line-number',
            '--color',
            'never',
            String(input.pattern),
          ];
          if (input.glob) {
            args.push('--glob', String(input.glob));
          }
          const processHandle = Bun.spawn({
            cmd: args,
            cwd: context.cwd,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(processHandle.stdout).text(),
            new Response(processHandle.stderr).text(),
            processHandle.exited,
          ]);

          return ok(toolCallId, 'Grep', {
            exitCode,
            stdout: truncateText(stdout, context.outputLimit),
            stderr: truncateText(stderr, context.outputLimit),
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Grep',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'Glob',
      description:
        'Find files matching a glob pattern (e.g. "**/*.ts"). Returns workspace-relative paths sorted by mtime desc. Skips node_modules, .git, dist, .claude.',
      inputSchema: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const pattern = String(input.pattern);
          const requestedCwd =
            input.cwd === undefined ? '.' : String(input.cwd);
          const effective = resolveInside(context.cwd, requestedCwd);

          const collected: { path: string; mtime: number }[] = [];
          let truncated = false;
          const glob = new Bun.Glob(pattern);
          for await (const rel of glob.scan({
            cwd: effective,
            dot: true,
          })) {
            const normalized = rel.split(sep).join('/');
            if (hasSkippedSegment(normalized)) continue;
            const absolute = resolve(effective, rel);
            let mtime = 0;
            try {
              const info = await stat(absolute);
              mtime = info.mtimeMs;
            } catch {
              continue;
            }
            collected.push({
              path: relativeToRoot(context.cwd, absolute),
              mtime,
            });
            if (collected.length > GLOB_RESULT_LIMIT) {
              truncated = true;
              break;
            }
          }
          collected.sort((a, b) => b.mtime - a.mtime);
          if (collected.length > GLOB_RESULT_LIMIT) {
            collected.length = GLOB_RESULT_LIMIT;
          }
          return ok(toolCallId, 'Glob', {
            cwd: relativeToRoot(context.cwd, effective),
            pattern,
            matches: collected.map((entry) => entry.path),
            count: collected.length,
            truncated,
            truncationMarker: truncated
              ? `... (truncated: showing first ${GLOB_RESULT_LIMIT} results sorted by mtime desc)`
              : undefined,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Glob',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'LS',
      description:
        'List the immediate entries of a directory inside the workspace. Dotfiles hidden unless hidden=true. Non-recursive; use Glob for recursive search.',
      inputSchema: z.object({
        path: z.string(),
        hidden: z.boolean().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const requestedPath = String(input.path);
          const showHidden = Boolean(input.hidden);
          const effective = resolveInside(context.cwd, requestedPath);

          const dirents = await readdir(effective, { withFileTypes: true });
          const entries: {
            name: string;
            type: 'dir' | 'file' | 'symlink';
            size?: number;
          }[] = [];
          for (const dirent of dirents) {
            if (!showHidden && dirent.name.startsWith('.')) continue;
            let type: 'dir' | 'file' | 'symlink';
            if (dirent.isSymbolicLink()) type = 'symlink';
            else if (dirent.isDirectory()) type = 'dir';
            else if (dirent.isFile()) type = 'file';
            else continue;

            const entry: { name: string; type: typeof type; size?: number } = {
              name: dirent.name,
              type,
            };
            if (type === 'file') {
              try {
                const info = await stat(resolve(effective, dirent.name));
                entry.size = info.size;
              } catch {
                // ignore stat failure; omit size
              }
            }
            entries.push(entry);
          }

          entries.sort((a, b) => {
            if (a.type === 'dir' && b.type !== 'dir') return -1;
            if (a.type !== 'dir' && b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
          });

          let truncated = false;
          if (entries.length > LS_RESULT_LIMIT) {
            truncated = true;
            entries.length = LS_RESULT_LIMIT;
          }

          return ok(toolCallId, 'LS', {
            path: relativeToRoot(context.cwd, effective),
            entries,
            count: entries.length,
            truncated,
            truncationMarker: truncated
              ? `... (truncated: showing first ${LS_RESULT_LIMIT} entries)`
              : undefined,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'LS',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  ];
}
