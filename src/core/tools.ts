import { realpathSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { z } from 'zod';
import { type AgentManager, createMultiAgentTools } from '@/core/agent-manager';
import type { AgentDefinition } from '@/core/agents';
import {
  ApplyPatchError,
  deriveUpdatedContents,
  parsePatch,
} from '@/core/apply-patch';
import { computeLineDiff } from '@/core/diff';
import { EditMatchError, replace } from '@/core/edit-match';
import { ensureParent, resolveInside, truncateText } from '@/core/fs';
import {
  LSP_OPERATIONS,
  type LspConnect,
  type LspOperation,
  runLspOperation,
  serverForFile,
} from '@/core/lsp';
import { appendSessionEvent } from '@/core/session-store';
import { listSkillFiles, type SkillDefinition } from '@/core/skills';
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
  PatchFilePreview,
  QuestionOption,
  TodoItem,
  TodoStatus,
  ToolContext,
  ToolName,
  ToolResult,
  ToolSpec,
} from '@/types';

export type SpawnSubAgentResult = {
  taskId: string;
  text: string;
  toolCalls: number;
};

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
  agents?: AgentDefinition[];
  spawnSubAgent?: (input: {
    agent: AgentDefinition;
    description: string;
    prompt: string;
    taskId?: string;
  }) => Promise<SpawnSubAgentResult>;
  skills?: SkillDefinition[];
  lspServerIds?: Set<string>;
  lspConnect?: LspConnect;
  // When present, the multi-agent tools (spawn_agent / send_input /
  // wait_agent / close_agent / list_agents) are registered. Never passed to
  // sub-agents, so they cannot recurse.
  agentManager?: AgentManager;
  multiAgentVersion?: 'v1' | 'v2';
  // Resolves an executable on PATH (defaults to Bun.which). Injectable so the
  // missing-ripgrep path is deterministically testable.
  which?: (command: string) => boolean;
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

// Verbatim from ref/codex/codex-rs/tools/src/apply_patch_tool.rs
// (APPLY_PATCH_JSON_TOOL_DESCRIPTION) so the model sees the exact contract it
// is trained on.
const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files.
Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

May be immediately followed by *** Move to: <new path> if you want to rename the file.
Then one or more “hunks”, each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change’s [context_after] lines in the second change’s [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

- If a code block is repeated so many times in a class or function such that even a single \`@@\` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple \`@@\` statements to jump to the right context. For instance:

@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]

The full grammar definition is below:
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE

A full patch can combine several operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file
- File references can only be relative, NEVER ABSOLUTE.
`;

type PatchPlanItem = {
  preview: PatchFilePreview;
  apply: () => Promise<void>;
};

async function planPatch(
  cwd: string,
  patchText: string,
): Promise<PatchPlanItem[]> {
  const hunks = parsePatch(patchText);
  if (hunks.length === 0) {
    throw new ApplyPatchError('No files were modified.');
  }
  const plan: PatchPlanItem[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === 'add') {
      const abs = resolveInside(cwd, hunk.path);
      const diff = computeLineDiff('', hunk.contents);
      diff.created = true;
      plan.push({
        preview: {
          path: relativeToRoot(cwd, abs),
          op: 'add',
          diff,
        },
        apply: async () => {
          await ensureParent(abs);
          await writeFile(abs, hunk.contents, 'utf8');
        },
      });
      continue;
    }
    if (hunk.kind === 'delete') {
      const abs = resolveInside(cwd, hunk.path);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        throw new ApplyPatchError(
          `Failed to delete file ${hunk.path}: file not found`,
        );
      }
      const diff = computeLineDiff(content, '');
      plan.push({
        preview: { path: relativeToRoot(cwd, abs), op: 'delete', diff },
        apply: async () => {
          const info = await stat(abs);
          if (info.isDirectory()) {
            throw new ApplyPatchError(
              `Failed to delete ${hunk.path}: path is a directory`,
            );
          }
          await rm(abs);
        },
      });
      continue;
    }
    // update
    const abs = resolveInside(cwd, hunk.path);
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      throw new ApplyPatchError(
        `Failed to read file to update ${hunk.path}: file not found`,
      );
    }
    const next = deriveUpdatedContents(content, hunk.path, hunk.chunks);
    const diff = computeLineDiff(content, next);
    if (hunk.movePath !== undefined) {
      const dest = resolveInside(cwd, hunk.movePath);
      plan.push({
        preview: {
          path: relativeToRoot(cwd, abs),
          op: 'move',
          movePath: relativeToRoot(cwd, dest),
          diff,
        },
        apply: async () => {
          await ensureParent(dest);
          await writeFile(dest, next, 'utf8');
          const info = await stat(abs);
          if (info.isDirectory()) {
            throw new ApplyPatchError(
              `Failed to remove original ${hunk.path}: path is a directory`,
            );
          }
          await rm(abs);
        },
      });
      continue;
    }
    plan.push({
      preview: { path: relativeToRoot(cwd, abs), op: 'update', diff },
      apply: async () => {
        await writeFile(abs, next, 'utf8');
      },
    });
  }
  return plan;
}

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

// Sniff an image media type from magic bytes first (authoritative), then fall
// back to the file extension. Returns null for non-images.
function sniffImageMediaType(buf: Buffer, path: string): string | null {
  // Magic bytes first (authoritative). Each signature is gated on its own
  // length so short-but-valid headers (JPEG = 3 bytes, GIF = 6) still match.
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return null;
}

// Byte-based binary sniff (mirrors opencode read): a NUL byte in the sample, or
// >30% non-text bytes, marks the file binary.
function isLikelyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.length === 0) return false;
  let nonText = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const printable =
      byte === 9 ||
      byte === 10 ||
      byte === 13 ||
      byte === 12 ||
      (byte >= 0x20 && byte !== 0x7f);
    if (!printable) nonText += 1;
  }
  return nonText / sample.length > 0.3;
}

const READ_LINE_MAX_CHARS = 2000;

async function suggestSiblingPaths(absMissing: string): Promise<string[]> {
  const parent = resolve(absMissing, '..');
  const base = absMissing.split(sep).pop()?.toLowerCase() ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  try {
    const entries = await readdir(parent);
    const scored = entries
      .map((name) => {
        const lower = name.toLowerCase();
        let score = 0;
        if (lower === base) score = 100;
        else if (lower.startsWith(stem) || stem.startsWith(lower)) score = 60;
        else if (stem.length >= 3 && lower.includes(stem)) score = 40;
        else if (base.length >= 3 && lower.includes(base.slice(0, 3)))
          score = 10;
        return { name, score };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((e) => e.name);
    return scored;
  } catch {
    return [];
  }
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
        'Read a file from the workspace. Returns line-numbered content. Supports startLine/endLine or opencode-style offset/limit. Reads a directory as a sorted listing; images are shown to you directly; binary files are refused.',
      inputSchema: z.object({
        filePath: z.string(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const requested = String(input.filePath);
          const path = resolveInside(context.cwd, requested);
          const relPath = relativeToRoot(context.cwd, path);

          let info: Awaited<ReturnType<typeof stat>>;
          try {
            info = await stat(path);
          } catch {
            const suggestions = await suggestSiblingPaths(path);
            const hint =
              suggestions.length > 0
                ? ` Did you mean: ${suggestions.join(', ')}?`
                : '';
            return fail(
              toolCallId,
              'Read',
              `File not found: ${requested}.${hint}`,
            );
          }

          // Directory → sorted listing (dirs get a trailing slash).
          if (info.isDirectory()) {
            const dirents = await readdir(path, { withFileTypes: true });
            const names = dirents
              .map((d) =>
                d.isDirectory() || d.isSymbolicLink() ? `${d.name}/` : d.name,
              )
              .sort((a, b) => a.localeCompare(b));
            const start = Number(input.offset ?? input.startLine ?? 1);
            const max = Number(input.limit ?? context.readLineLimit);
            const slice = names.slice(start - 1, start - 1 + max);
            const truncated = names.length > start - 1 + slice.length;
            return ok(toolCallId, 'Read', {
              path: relPath,
              kind: 'dir',
              entries: slice,
              count: slice.length,
              total: names.length,
              truncated,
              content: truncateText(
                slice.join('\n') || '(empty directory)',
                context.outputLimit,
              ),
            });
          }

          const bytes = await readFile(path);

          // Images are shown to the model directly (same plumbing as
          // view_image).
          const imageType = sniffImageMediaType(bytes, path);
          if (imageType) {
            const dataUrl = `data:${imageType};base64,${bytes.toString('base64')}`;
            return {
              toolCallId,
              toolName: 'Read' as const,
              output: {
                path: relPath,
                kind: 'image',
                mediaType: imageType,
                bytes: bytes.length,
              },
              media: {
                kind: 'image' as const,
                dataUrl,
                mediaType: imageType,
                detail: null,
              },
            };
          }

          if (isLikelyBinary(bytes)) {
            return fail(
              toolCallId,
              'Read',
              `Cannot read ${requested}: appears to be a binary file (${bytes.length} bytes). Use Bash with an appropriate tool if you need its contents.`,
            );
          }

          const file = bytes.toString('utf8');
          const lines = file.split('\n');
          // Drop the trailing empty element from a final newline so line
          // counts match `wc -l`-style expectations.
          if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
          }
          const totalLines = lines.length;
          const startLine = Number(input.offset ?? input.startLine ?? 1);
          if (totalLines > 0 && startLine > totalLines) {
            return fail(
              toolCallId,
              'Read',
              `offset ${startLine} is beyond end of file (${totalLines} lines)`,
            );
          }
          const maxLines =
            input.limit !== undefined
              ? Number(input.limit)
              : input.endLine !== undefined
                ? Number(input.endLine) - startLine + 1
                : context.readLineLimit;
          const endLine = Math.min(
            totalLines,
            startLine + Math.max(1, maxLines) - 1,
          );
          const numbered = lines
            .slice(startLine - 1, endLine)
            .map((line, i) => {
              const n = startLine + i;
              const text =
                line.length > READ_LINE_MAX_CHARS
                  ? `${line.slice(0, READ_LINE_MAX_CHARS)}… [line truncated]`
                  : line;
              return `${n}: ${text}`;
            })
            .join('\n');
          return ok(toolCallId, 'Read', {
            path: relPath,
            kind: 'text',
            startLine,
            endLine,
            totalLines,
            truncated: endLine < totalLines,
            content: truncateText(numbered, context.outputLimit),
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
      name: 'view_image',
      description:
        "View a local image from the filesystem (only use if given a filepath by the user, and the image isn't already attached to the conversation). The image is shown to you directly.",
      inputSchema: z.object({
        path: z.string(),
        detail: z.enum(['original']).optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const requested = String(input.path ?? '');
          if (requested.length === 0) {
            return fail(toolCallId, 'view_image', 'path must not be empty');
          }
          const abs = resolveInside(context.cwd, requested);
          let info: Awaited<ReturnType<typeof stat>>;
          try {
            info = await stat(abs);
          } catch {
            return fail(
              toolCallId,
              'view_image',
              `unable to locate image at \`${requested}\``,
            );
          }
          if (!info.isFile()) {
            return fail(
              toolCallId,
              'view_image',
              `image path \`${requested}\` is not a file`,
            );
          }
          const bytes = await readFile(abs);
          const mediaType = sniffImageMediaType(bytes, abs);
          if (!mediaType) {
            return fail(
              toolCallId,
              'view_image',
              `\`${requested}\` is not a recognized image (png, jpeg, gif, webp, bmp, svg)`,
            );
          }
          const detail =
            input.detail === 'original' ? ('original' as const) : null;
          const dataUrl = `data:${mediaType};base64,${bytes.toString('base64')}`;
          return {
            toolCallId,
            toolName: 'view_image' as const,
            output: {
              path: relativeToRoot(context.cwd, abs),
              image_url: dataUrl,
              detail,
              bytes: bytes.length,
              mediaType,
            },
            media: {
              kind: 'image' as const,
              dataUrl,
              mediaType,
              detail,
            },
          };
        } catch (error) {
          return fail(
            toolCallId,
            'view_image',
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
        'Replace a string in a file. Tries an exact match first, then progressively fuzzier matchers (line-trim, block-anchor, whitespace/indentation/escape normalized) so a near-miss old_string still applies. Fails if nothing matches or the match is ambiguous (use replaceAll for repeated text).',
      inputSchema: z.object({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      }),
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const path = resolveInside(context.cwd, String(input.filePath));
          const content = await readFile(path, 'utf8');
          const oldString = String(input.oldString);
          let next: string;
          try {
            next = replace(
              content,
              oldString,
              String(input.newString),
              Boolean(input.replaceAll),
            );
          } catch (matchError) {
            if (matchError instanceof EditMatchError) {
              return fail(
                toolCallId,
                'Edit',
                `${matchError.message} (path: ${path})`,
              );
            }
            throw matchError;
          }
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
      name: 'apply_patch',
      description: APPLY_PATCH_DESCRIPTION,
      inputSchema: z.object({
        input: z.string(),
      }),
      execute: async (input, runtimeContext) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          // Accept the Codex JSON shape (`input`), opencode's `patchText`, or a
          // bare string fallback for clients that don't wrap the arg.
          const raw =
            typeof input.input === 'string'
              ? input.input
              : typeof (input as { patchText?: unknown }).patchText === 'string'
                ? (input as { patchText: string }).patchText
                : typeof (input as { patch?: unknown }).patch === 'string'
                  ? (input as { patch: string }).patch
                  : '';
          if (raw.trim().length === 0) {
            return fail(
              toolCallId,
              'apply_patch',
              'apply_patch requires the full patch text (the entire contents of the apply_patch command, beginning with "*** Begin Patch").',
            );
          }

          let plan: PatchPlanItem[];
          try {
            plan = await planPatch(context.cwd, raw);
          } catch (planError) {
            if (planError instanceof ApplyPatchError) {
              return fail(toolCallId, 'apply_patch', planError.message);
            }
            throw planError;
          }

          const files: PatchFilePreview[] = plan.map((p) => p.preview);
          const gate = await requireApproval(runtimeContext, 'apply_patch', {
            kind: 'apply-patch',
            files,
          });
          if (!gate.approved) {
            return fail(
              toolCallId,
              'apply_patch',
              rejectionMessage('apply_patch', gate.reason),
            );
          }

          // Apply in patch order. A mid-stream failure is reported with what
          // already succeeded so the model can recover.
          const added: string[] = [];
          const modified: string[] = [];
          const deleted: string[] = [];
          for (let i = 0; i < plan.length; i += 1) {
            const item = plan[i] as PatchPlanItem;
            try {
              await item.apply();
            } catch (applyError) {
              const message =
                applyError instanceof Error
                  ? applyError.message
                  : String(applyError);
              return fail(
                toolCallId,
                'apply_patch',
                `${message}\n\nApplied before failure: ${
                  [...added, ...modified, ...deleted].join(', ') || '(none)'
                }`,
              );
            }
            const { op, path, movePath } = item.preview;
            if (op === 'add') added.push(path);
            else if (op === 'delete') deleted.push(path);
            else if (op === 'move') modified.push(`${path} → ${movePath}`);
            else modified.push(path);
          }

          return ok(toolCallId, 'apply_patch', {
            applied: true,
            added,
            modified,
            deleted,
            files,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'apply_patch',
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
        'Search file contents with ripgrep (respects .gitignore). pattern is a regex unless literal=true. Options: path (dir/file to search), glob/include (file filter), type (rg file type), ignoreCase (-i), literal (-F), context (lines of context around each match), multiline, output_mode ("content" default | "files_with_matches" | "count"), limit (max matches/files, default 100).',
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        include: z.string().optional(),
        type: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        literal: z.boolean().optional(),
        context: z.number().int().min(0).optional(),
        multiline: z.boolean().optional(),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .optional(),
        limit: z.number().int().positive().optional(),
        head_limit: z.number().int().positive().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const whichImpl =
            deps.which ?? ((c: string) => Boolean(Bun.which(c)));
          if (!whichImpl('rg')) {
            return fail(
              toolCallId,
              'Grep',
              'ripgrep (`rg`) is not installed or not on PATH. Install it (e.g. `brew install ripgrep` / `apt-get install ripgrep`) or use Bash with `grep`/`git grep` instead.',
            );
          }
          const mode =
            input.output_mode === 'files_with_matches' ||
            input.output_mode === 'count'
              ? input.output_mode
              : 'content';
          const args = ['rg', '--color', 'never'];
          if (mode === 'content') {
            args.push('--no-heading', '--with-filename', '--line-number');
            const context_ =
              typeof input.context === 'number' ? input.context : undefined;
            if (context_ !== undefined && context_ > 0) {
              args.push('-C', String(Math.trunc(context_)));
            }
          } else if (mode === 'files_with_matches') {
            args.push('--files-with-matches');
          } else {
            args.push('--count');
          }
          if (input.ignoreCase) args.push('-i');
          if (input.literal) args.push('-F');
          if (input.multiline) args.push('--multiline', '--multiline-dotall');
          const globPat =
            typeof input.glob === 'string'
              ? input.glob
              : typeof input.include === 'string'
                ? input.include
                : undefined;
          if (globPat) args.push('--glob', globPat);
          if (typeof input.type === 'string') {
            args.push('--type', input.type);
          }
          args.push('--', String(input.pattern));
          if (typeof input.path === 'string' && input.path.length > 0) {
            // Confine to the workspace; rg is given an absolute resolved path.
            args.push(resolveInside(context.cwd, input.path));
          }

          const processHandle = Bun.spawn({
            cmd: args,
            cwd: context.cwd,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [rawStdout, stderr, exitCode] = await Promise.all([
            new Response(processHandle.stdout).text(),
            new Response(processHandle.stderr).text(),
            processHandle.exited,
          ]);

          const headLimit =
            typeof input.limit === 'number'
              ? input.limit
              : typeof input.head_limit === 'number'
                ? input.head_limit
                : 100;
          const allLines = rawStdout.split('\n');
          // rg ends with a trailing newline → drop the empty tail.
          if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
            allLines.pop();
          }
          const total = allLines.length;
          const capped = allLines
            .slice(0, headLimit)
            .map((line) =>
              line.length > READ_LINE_MAX_CHARS
                ? `${line.slice(0, READ_LINE_MAX_CHARS)}… [line truncated]`
                : line,
            );
          const truncated = total > capped.length;
          const stdout = truncateText(capped.join('\n'), context.outputLimit);

          return ok(toolCallId, 'Grep', {
            mode,
            exitCode,
            matchCount: total,
            truncated,
            truncationMarker: truncated
              ? `... (truncated: showing first ${capped.length} of ${total})`
              : undefined,
            stdout,
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
      name: 'Task',
      description: deps.agents
        ? `Launch a sub-agent to handle a complex, multi-step task in its own context.

You must specify subagent_type. Available agents:
${deps.agents.map((a) => `- "${a.name}": ${a.description}`).join('\n')}

Usage notes:
- The sub-agent runs autonomously and returns a single final message. Its work is not shown to the user — relay a concise summary yourself.
- Each invocation starts fresh unless you pass task_id from a prior Task result to continue the same sub-agent session.
- Give a highly detailed, self-contained prompt and state exactly what the sub-agent should return. Tell it whether to write code or only research, and how to verify its work.
- Sub-agents cannot themselves call Task (one branch deep).`
        : 'Launch a sub-agent to handle a complex, multi-step task in its own context.',
      inputSchema: z.object({
        description: z.string().min(1),
        prompt: z.string().min(1),
        subagent_type: z.string().min(1),
        task_id: z.string().optional(),
        command: z.string().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          if (!deps.spawnSubAgent || !deps.agents) {
            return fail(
              toolCallId,
              'Task',
              'Task is not wired in this runtime',
            );
          }
          const description = String(input.description ?? '').trim();
          const prompt = String(input.prompt ?? '').trim();
          const subagentType = String(input.subagent_type ?? '').trim();
          if (prompt.length === 0) {
            return fail(
              toolCallId,
              'Task',
              'prompt must be a non-empty string',
            );
          }
          const agent = deps.agents.find((a) => a.name === subagentType);
          if (!agent) {
            const names = deps.agents.map((a) => a.name).join(', ');
            return fail(
              toolCallId,
              'Task',
              `Unknown agent type: '${subagentType}' is not a valid agent type. Valid: ${names}`,
            );
          }
          const taskId =
            typeof input.task_id === 'string' && input.task_id.length > 0
              ? input.task_id
              : undefined;
          const sub = await deps.spawnSubAgent({
            agent,
            description,
            prompt,
            taskId,
          });
          return ok(toolCallId, 'Task', {
            task_id: sub.taskId,
            agent: agent.name,
            description,
            tool_calls: sub.toolCalls,
            result: sub.text,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Task',
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

  // The Skill tool only exists when at least one skill is discoverable —
  // otherwise it is dead surface (mirrors opencode listing skills in-context).
  if (deps.skills && deps.skills.length > 0) {
    const skills = deps.skills;
    builtins.push({
      name: 'Skill',
      description: `Load a specialized skill when the task matches one of the available skills. Injects the skill's instructions and resource-file references into the conversation.

Available skills:
${skills.map((s) => `- "${s.name}": ${s.description || '(no description)'}`).join('\n')}`,
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const name = String(input.name ?? '').trim();
          const info = skills.find((s) => s.name === name);
          if (!info) {
            const available = skills.map((s) => s.name).join(', ') || 'none';
            return fail(
              toolCallId,
              'Skill',
              `Skill "${name}" not found. Available skills: ${available}`,
            );
          }
          const files = await listSkillFiles(info.dir, 10);
          const relFiles = files.map(
            (f) => `<file>${relativeToRoot(context.cwd, f)}</file>`,
          );
          const output = [
            `<skill_content name="${info.name}">`,
            `# Skill: ${info.name}`,
            '',
            info.content.trim(),
            '',
            `Base directory for this skill: ${relativeToRoot(context.cwd, info.dir)}`,
            'Relative paths in this skill (e.g. scripts/, reference/) are relative to that base directory.',
            'Note: file list is sampled.',
            '',
            '<skill_files>',
            relFiles.join('\n'),
            '</skill_files>',
            '</skill_content>',
          ].join('\n');
          return ok(toolCallId, 'Skill', {
            name: info.name,
            dir: relativeToRoot(context.cwd, info.dir),
            fileCount: files.length,
            content: output,
          });
        } catch (error) {
          return fail(
            toolCallId,
            'Skill',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });
  }

  // The LSP tool only exists when a language server for some project file type
  // is resolvable (mirrors opencode gating `lsp` behind an available client).
  if (deps.lspServerIds && deps.lspServerIds.size > 0) {
    const availableIds = deps.lspServerIds;
    const lspConnect = deps.lspConnect;
    builtins.push({
      name: 'LSP',
      description:
        'Query a language server for code intelligence. operation: goToDefinition | findReferences | hover | documentSymbol | workspaceSymbol | goToImplementation | prepareCallHierarchy | incomingCalls | outgoingCalls. line and character are 1-based (as shown in your editor). query is only used by workspaceSymbol.',
      inputSchema: z.object({
        operation: z.enum([
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
        ]),
        filePath: z.string(),
        line: z.number().int().positive(),
        character: z.number().int().positive(),
        query: z.string().optional(),
      }),
      execute: async (input) => {
        const toolCallId = String(input.toolCallId ?? crypto.randomUUID());
        try {
          const operation = String(input.operation) as LspOperation;
          if (!LSP_OPERATIONS.includes(operation)) {
            return fail(
              toolCallId,
              'LSP',
              `unsupported operation '${operation}'`,
            );
          }
          const abs = resolveInside(context.cwd, String(input.filePath));
          let info: Awaited<ReturnType<typeof stat>>;
          try {
            info = await stat(abs);
          } catch {
            return fail(toolCallId, 'LSP', `File not found: ${input.filePath}`);
          }
          if (!info.isFile()) {
            return fail(toolCallId, 'LSP', `${input.filePath} is not a file`);
          }
          const spec = serverForFile(abs);
          if (!spec || !availableIds.has(spec.id)) {
            return fail(
              toolCallId,
              'LSP',
              `No LSP server available for ${input.filePath}.`,
            );
          }
          const result = await runLspOperation(
            {
              operation,
              filePath: abs,
              line: Number(input.line),
              character: Number(input.character),
              query: typeof input.query === 'string' ? input.query : undefined,
              cwd: context.cwd,
            },
            lspConnect,
          );
          const empty =
            result == null || (Array.isArray(result) && result.length === 0);
          return ok(toolCallId, 'LSP', {
            operation,
            server: spec.id,
            empty,
            result: empty ? null : result,
            text: empty
              ? `No results found for ${operation}.`
              : truncateText(
                  JSON.stringify(result, null, 2),
                  context.outputLimit,
                ),
          });
        } catch (error) {
          return fail(
            toolCallId,
            'LSP',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    });
  }

  if (deps.agentManager) {
    builtins.push(
      ...createMultiAgentTools(
        deps.agentManager,
        deps.multiAgentVersion ?? 'v2',
        deps.agents?.map((a) => a.name) ?? ['general'],
      ),
    );
  }

  if (deps.mcpTools && deps.mcpTools.length > 0) {
    return [...builtins, ...deps.mcpTools];
  }
  return builtins;
}
