import { realpathSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { computeLineDiff } from '@/core/diff';
import { ensureParent, resolveInside, truncateText } from '@/core/fs';
import { appendSessionEvent } from '@/core/session-store';
import {
  fetchWithLimits,
  formatBody,
  WebFetchFailure,
  type WebFetchFormat,
} from '@/core/web-fetch';
import {
  type ExaSearchDeps,
  searchWithExa,
  WebSearchFailure,
} from '@/core/web-search';
import type {
  ApprovalPreview,
  QuestionOption,
  TodoItem,
  TodoStatus,
  ToolContext,
  ToolName,
  ToolResult,
  ToolSpec,
} from '@/types';

export type ToolDeps = {
  fetchImpl?: typeof fetch;
  summarize?: (input: {
    prompt: string;
    content: string;
    url: string;
  }) => Promise<string>;
  exaApiKey?: string;
  webFetchTimeoutMs?: number;
  webFetchMaxBytes?: number;
  mcpTools?: ToolSpec[];
};

async function requireApproval(
  ctx: ToolContext,
  toolName: ToolName,
  preview: ApprovalPreview,
): Promise<{ approved: boolean; reason?: string }> {
  if (!ctx.requestApproval) return { approved: true };
  const decision = await ctx.requestApproval({ toolName, preview });
  if (decision === 'approve' || decision === 'approve_forever') {
    return { approved: true };
  }
  if (decision === 'reject') {
    return { approved: false };
  }
  // rich rejection: { decision: 'reject', reason }
  return { approved: false, reason: decision.reason };
}

function rejectionMessage(toolName: ToolName, reason?: string): string {
  if (reason && reason.trim().length > 0) {
    return `user rejected ${toolName}: ${reason.trim()}`;
  }
  return `user rejected ${toolName}`;
}

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

export function createBuiltinTools(
  context: ToolContext,
  deps: ToolDeps = {},
): ToolSpec[] {
  const builtins: ToolSpec[] = [
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
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const path = resolveInside(context.cwd, String(input.filePath));
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
          const diff = computeLineDiff(oldContent, nextContent);
          if (created) diff.created = true;
          const gate = await requireApproval(runtimeContext, 'Write', {
            kind: 'write',
            path,
            bytes: nextContent.length,
            created,
            diff,
          });
          if (!gate.approved) {
            return fail(
              toolCallId,
              'Write',
              `${rejectionMessage('Write', gate.reason)} (path: ${path})`,
            );
          }
          await ensureParent(path);
          await writeFile(path, nextContent, 'utf8');
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
      execute: async (input, runtimeContext) => {
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
          const diff = computeLineDiff(content, next);
          const gate = await requireApproval(runtimeContext, 'Edit', {
            kind: 'edit',
            path,
            diff,
          });
          if (!gate.approved) {
            return fail(
              toolCallId,
              'Edit',
              `${rejectionMessage('Edit', gate.reason)} (path: ${path})`,
            );
          }
          await writeFile(path, next, 'utf8');
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
      name: 'MultiEdit',
      description:
        "Apply an ordered list of edits to a single file atomically. All edits succeed or none apply. Each edit's old_string is matched against the in-memory buffer produced by earlier edits in the list. Use replace_all=true on an edit to rewrite every occurrence in the current buffer.",
      inputSchema: z.object({
        path: z.string(),
        edits: z.array(
          z.object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: z.boolean().optional(),
          }),
        ),
      }),
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const rawEdits = input.edits;
          if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
            return fail(
              toolCallId,
              'MultiEdit',
              'edits array must not be empty',
            );
          }
          const filePath = resolveInside(context.cwd, String(input.path));

          const edits = rawEdits.map((raw, index) => {
            const obj = (raw ?? {}) as Record<string, unknown>;
            return {
              index,
              oldString:
                typeof obj.old_string === 'string' ? obj.old_string : '',
              newString:
                typeof obj.new_string === 'string' ? obj.new_string : '',
              replaceAll: Boolean(obj.replace_all),
            };
          });

          let originalContent = '';
          let created = false;
          try {
            originalContent = await readFile(filePath, 'utf8');
          } catch (readError) {
            if (
              readError instanceof Error &&
              (readError as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
              if (edits[0]?.oldString === '') {
                originalContent = '';
                created = true;
              } else {
                return fail(
                  toolCallId,
                  'MultiEdit',
                  `File not found: ${filePath}. Only the first edit may use an empty old_string to create a new file.`,
                );
              }
            } else {
              throw readError;
            }
          }

          let buffer = originalContent;
          for (const edit of edits) {
            const { oldString, newString, replaceAll, index } = edit;
            if (index === 0 && created && oldString === '') {
              buffer = newString;
              continue;
            }
            if (oldString === '') {
              return fail(
                toolCallId,
                'MultiEdit',
                `edit[${index}]: old_string must not be empty (only the first edit on a new file may use an empty string)`,
              );
            }
            if (oldString === newString) {
              return fail(
                toolCallId,
                'MultiEdit',
                `edit[${index}]: old_string and new_string are identical (no-op)`,
              );
            }
            const occurrences = buffer.split(oldString).length - 1;
            if (occurrences === 0) {
              return fail(
                toolCallId,
                'MultiEdit',
                `edit[${index}] in ${filePath}: no match for old_string`,
              );
            }
            if (occurrences > 1 && !replaceAll) {
              return fail(
                toolCallId,
                'MultiEdit',
                `edit[${index}] in ${filePath}: ambiguous match (${occurrences} occurrences); set replace_all to apply to all`,
              );
            }
            buffer = replaceAll
              ? buffer.replaceAll(oldString, newString)
              : buffer.replace(oldString, newString);
          }

          const diff = computeLineDiff(originalContent, buffer);
          if (created) diff.created = true;
          const gate = await requireApproval(runtimeContext, 'MultiEdit', {
            kind: 'multi-edit',
            path: filePath,
            created,
            diff,
          });
          if (!gate.approved) {
            return fail(
              toolCallId,
              'MultiEdit',
              `${rejectionMessage('MultiEdit', gate.reason)} (path: ${filePath})`,
            );
          }
          await ensureParent(filePath);
          await writeFile(filePath, buffer, 'utf8');
          return ok(toolCallId, 'MultiEdit', {
            path: filePath,
            diff,
            created,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'MultiEdit',
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
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const command = String(input.command);
          const gate = await requireApproval(runtimeContext, 'Bash', {
            kind: 'bash',
            command,
          });
          if (!gate.approved) {
            return fail(
              toolCallId,
              'Bash',
              rejectionMessage('Bash', gate.reason),
            );
          }
          const result = await executeShellCommand(command, {
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
    {
      name: 'AskUserQuestion',
      description:
        'Pause and ask the user a question with 2-4 structured options. Accepts either a single question (`{ question, options, ... }`) or a multi-question batch (`{ questions: [{ question, options, ... }] }`, up to 3). Use only when a decision genuinely requires the user (preference, ambiguous intent, irreversible side effect). Do not use to stall in prose.',
      inputSchema: z.union([
        z.object({
          question: z.string().min(1),
          header: z.string().max(30).optional(),
          options: z
            .array(
              z.object({
                label: z.string().min(1),
                description: z.string().optional(),
              }),
            )
            .min(2)
            .max(4),
          multiSelect: z.boolean().optional(),
          allowCustom: z.boolean().optional(),
          isSecret: z.boolean().optional(),
        }),
        z.object({
          questions: z
            .array(
              z.object({
                question: z.string().min(1),
                header: z.string().max(30).optional(),
                options: z
                  .array(
                    z.object({
                      label: z.string().min(1),
                      description: z.string().optional(),
                    }),
                  )
                  .min(2)
                  .max(4),
                multiSelect: z.boolean().optional(),
                allowCustom: z.boolean().optional(),
                isSecret: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(3),
        }),
      ]),
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          if (!runtimeContext.requestUserAnswer) {
            return fail(
              toolCallId,
              'AskUserQuestion',
              'AskUserQuestion is not wired in this runtime',
            );
          }

          type RawQuestion = {
            question?: unknown;
            header?: unknown;
            options?: unknown;
            multiSelect?: unknown;
            allowCustom?: unknown;
            isSecret?: unknown;
          };

          const rawQuestions: RawQuestion[] = Array.isArray(
            (input as { questions?: unknown }).questions,
          )
            ? ((input as { questions: unknown[] }).questions as RawQuestion[])
            : [input as RawQuestion];

          if (rawQuestions.length < 1 || rawQuestions.length > 3) {
            return fail(
              toolCallId,
              'AskUserQuestion',
              `questions must have between 1 and 3 entries (got ${rawQuestions.length})`,
            );
          }

          type NormalizedQuestion = {
            question: string;
            header?: string;
            options: QuestionOption[];
            multiSelect: boolean;
            allowCustom: boolean;
            isSecret: boolean;
          };
          const normalized: NormalizedQuestion[] = [];
          for (let i = 0; i < rawQuestions.length; i += 1) {
            const raw = rawQuestions[i] ?? {};
            if (typeof raw.question !== 'string' || raw.question.length === 0) {
              return fail(
                toolCallId,
                'AskUserQuestion',
                `questions[${i}].question must be a non-empty string`,
              );
            }
            const rawOptions = Array.isArray(raw.options) ? raw.options : [];
            const options: QuestionOption[] = rawOptions
              .map((rawOpt) => {
                const obj = (rawOpt ?? {}) as Record<string, unknown>;
                const label = typeof obj.label === 'string' ? obj.label : '';
                const description =
                  typeof obj.description === 'string'
                    ? obj.description
                    : undefined;
                return { label, description };
              })
              .filter((opt) => opt.label.length > 0);
            if (options.length < 2 || options.length > 4) {
              return fail(
                toolCallId,
                'AskUserQuestion',
                `questions[${i}].options must have between 2 and 4 entries (got ${options.length})`,
              );
            }
            normalized.push({
              question: raw.question,
              header: typeof raw.header === 'string' ? raw.header : undefined,
              options,
              multiSelect: Boolean(raw.multiSelect),
              allowCustom: raw.allowCustom !== false,
              isSecret: Boolean(raw.isSecret),
            });
          }

          type PerAnswer = {
            question: string;
            header?: string;
            selected: string[];
            custom?: string;
          };
          const answers: PerAnswer[] = [];
          for (let i = 0; i < normalized.length; i += 1) {
            const q = normalized[i];
            if (!q) continue;
            const response = await runtimeContext.requestUserAnswer({
              questionId: crypto.randomUUID(),
              question: q.question,
              header: q.header,
              options: q.options,
              multiSelect: q.multiSelect,
              allowCustom: q.allowCustom,
              isSecret: q.isSecret,
              progress:
                normalized.length > 1
                  ? { current: i + 1, total: normalized.length }
                  : undefined,
            });
            if (response.kind === 'dismissed') {
              return fail(
                toolCallId,
                'AskUserQuestion',
                `user dismissed question ${i + 1} of ${normalized.length}`,
              );
            }
            const entry: PerAnswer = {
              question: q.question,
              ...(q.header ? { header: q.header } : {}),
              selected: response.selected,
              ...(response.custom !== undefined
                ? { custom: response.custom }
                : {}),
            };
            answers.push(entry);
          }

          // For single-question back-compat, expose flat fields too so existing
          // models / tests that read `output.answers` as a string[] keep working.
          if (answers.length === 1) {
            const only = answers[0];
            if (!only) {
              return fail(toolCallId, 'AskUserQuestion', 'no answer collected');
            }
            return ok(toolCallId, 'AskUserQuestion', {
              answers: only.selected,
              ...(only.custom !== undefined ? { custom: only.custom } : {}),
            });
          }

          return ok(toolCallId, 'AskUserQuestion', {
            answers,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'AskUserQuestion',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'WebFetch',
      description:
        'Fetch a URL and return its content. HTML is converted to Markdown by default; pass format="text" for plain text or "html" for raw HTML. Optionally pass a `prompt` to summarize the page against that prompt with a small model (saves parent-context tokens). Only http/https; binary content types are refused. 5MB / 30s caps.',
      inputSchema: z.object({
        url: z.string().min(1),
        prompt: z.string().optional(),
        format: z.enum(['markdown', 'text', 'html']).optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const rawUrl = String(input.url ?? '');
          if (!rawUrl) {
            return fail(
              toolCallId,
              'WebFetch',
              'url must be a non-empty string',
            );
          }
          const format: WebFetchFormat =
            input.format === 'text' || input.format === 'html'
              ? (input.format as WebFetchFormat)
              : 'markdown';
          const fetched = await fetchWithLimits(rawUrl, {
            fetchImpl: deps.fetchImpl,
            timeoutMs: deps.webFetchTimeoutMs,
            maxBytes: deps.webFetchMaxBytes,
          });
          const { body: shaped, format: appliedFormat } = formatBody(
            fetched.body,
            fetched.contentType,
            format,
          );
          let finalBody = shaped;
          let summarized = false;
          const prompt =
            typeof input.prompt === 'string' && input.prompt.trim().length > 0
              ? input.prompt.trim()
              : undefined;
          if (prompt && deps.summarize) {
            try {
              finalBody = await deps.summarize({
                prompt,
                content: shaped,
                url: fetched.finalUrl,
              });
              summarized = true;
            } catch (summarizeErr) {
              // Fall back to the raw shaped body; surface the failure as a note.
              finalBody = `${shaped}\n\n[juno] summarize failed: ${
                summarizeErr instanceof Error
                  ? summarizeErr.message
                  : String(summarizeErr)
              }`;
            }
          }
          finalBody = truncateText(finalBody, context.outputLimit);
          return ok(toolCallId, 'WebFetch', {
            url: rawUrl,
            finalUrl: fetched.finalUrl,
            status: fetched.status,
            contentType: fetched.contentType,
            format: appliedFormat,
            body: finalBody,
            bytes: fetched.bytes,
            truncated: fetched.truncated,
            upgraded: fetched.upgraded,
            summarized,
          });
        } catch (error) {
          if (error instanceof WebFetchFailure) {
            return fail(
              toolCallId,
              'WebFetch',
              `${error.kind}: ${error.message}`,
            );
          }
          return fail(
            toolCallId,
            'WebFetch',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      name: 'WebSearch',
      description:
        'Search the web with Exa and return shaped results. Requires EXA_API_KEY. Optional allowed_domains / blocked_domains filter the result set. Returns up to max_results (default 8, max 20) with title, url, snippet.',
      inputSchema: z.object({
        query: z.string().min(1),
        allowed_domains: z.array(z.string()).optional(),
        blocked_domains: z.array(z.string()).optional(),
        max_results: z.number().int().min(1).max(20).optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const query = String(input.query ?? '').trim();
          if (!query) {
            return fail(
              toolCallId,
              'WebSearch',
              'query must be a non-empty string',
            );
          }
          if (!deps.exaApiKey) {
            return fail(
              toolCallId,
              'WebSearch',
              'EXA_API_KEY is not set. Get a key at https://exa.ai/ and export EXA_API_KEY=…',
            );
          }
          const exaDeps: ExaSearchDeps = {
            apiKey: deps.exaApiKey,
            fetchImpl: deps.fetchImpl,
          };
          const allowed = Array.isArray(input.allowed_domains)
            ? (input.allowed_domains as unknown[]).map(String)
            : undefined;
          const blocked = Array.isArray(input.blocked_domains)
            ? (input.blocked_domains as unknown[]).map(String)
            : undefined;
          const maxResults =
            typeof input.max_results === 'number'
              ? Math.min(20, Math.max(1, Math.trunc(input.max_results)))
              : 8;
          const result = await searchWithExa(query, exaDeps, {
            includeDomains: allowed,
            excludeDomains: blocked,
            numResults: maxResults,
          });
          return ok(toolCallId, 'WebSearch', {
            query,
            provider: 'exa',
            num_results: result.results.length,
            results: result.results,
          });
        } catch (error) {
          if (error instanceof WebSearchFailure) {
            return fail(
              toolCallId,
              'WebSearch',
              `${error.kind}: ${error.message}`,
            );
          }
          return fail(
            toolCallId,
            'WebSearch',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
  ];

  if (deps.mcpTools && deps.mcpTools.length > 0) {
    return [...builtins, ...deps.mcpTools];
  }
  return builtins;
}
