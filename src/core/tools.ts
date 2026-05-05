import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { ensureParent, resolveInside, truncateText } from '@/core/fs';
import type { ToolContext, ToolResult, ToolSpec } from '@/types';

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
          await writeFile(path, String(input.content), 'utf8');
          return ok(toolCallId, 'Write', {
            path,
            bytes: String(input.content).length,
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
          return ok(toolCallId, 'Edit', { path, replaced: true });
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
  ];
}
