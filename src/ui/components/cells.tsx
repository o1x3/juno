import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { DiffHunk, DiffLine, DiffPayload } from '@/core/diff';
import type { TodoItem, ToolCall, ToolResult } from '@/types';
import { collapseHunkLines } from '@/ui/diff-render';
import { formatDuration, softWrap, truncatePath } from '@/ui/format';
import { renderMarkdown } from '@/ui/markdown';
import { colors, glyphs, type ThemeColor } from '@/ui/theme';

export type ToolEntry = {
  call: ToolCall;
  result?: ToolResult;
  startedAt: number;
  endedAt?: number;
};

export type TranscriptCell =
  | { id: string; kind: 'user'; text: string; timestamp?: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      streaming?: boolean;
      timestamp?: string;
    }
  | {
      id: string;
      kind: 'tool-group';
      tools: ToolEntry[];
      collapsed: boolean;
      complete: boolean;
    }
  | {
      id: string;
      kind: 'bash-direct';
      command: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
    }
  | {
      id: string;
      kind: 'error';
      title: string;
      detail: string;
      actionsHint?: string;
    }
  | {
      id: string;
      kind: 'plan-note';
      text: string;
    }
  | {
      id: string;
      kind: 'todo';
      todos: TodoItem[];
    };

function gutter(glyph: string, color: ThemeColor) {
  return <Text color={color}>{glyph} </Text>;
}

export function UserCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'user' }>;
  width: number;
}) {
  const wrapped = cell.text
    .split('\n')
    .flatMap((line) => softWrap(line, Math.max(20, width - 4)));
  return (
    <Box flexDirection="column" marginBottom={1}>
      {wrapped.map((line, i) => (
        <Box key={i} flexDirection="row">
          {i === 0 ? gutter(glyphs.user, colors.user) : <Text>{'  '}</Text>}
          <Text color={colors.user}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function AssistantCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'assistant' }>;
  width: number;
}) {
  const nodes = cell.text.length > 0 ? renderMarkdown(cell.text, width) : [];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        {gutter(glyphs.assistant, colors.assistant)}
        <Box flexDirection="column">
          {nodes.length > 0 ? (
            nodes
          ) : (
            <Text color="gray" dimColor italic>
              {cell.streaming ? 'thinking…' : ' '}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function extractDiff(result: ToolResult | undefined): {
  diff: DiffPayload;
  path: string;
} | null {
  if (!result || result.isError) return null;
  if (
    result.toolName !== 'Edit' &&
    result.toolName !== 'Write' &&
    result.toolName !== 'MultiEdit'
  ) {
    return null;
  }
  const output = result.output;
  if (!output || typeof output !== 'object') return null;
  const diff = (output as { diff?: unknown }).diff;
  const path = (output as { path?: unknown }).path;
  if (!diff || typeof diff !== 'object' || typeof path !== 'string') {
    return null;
  }
  if (!Array.isArray((diff as { hunks?: unknown }).hunks)) return null;
  return { diff: diff as DiffPayload, path };
}

function renderDiffLine(
  line: DiffLine,
  width: number,
  keyPrefix: string,
): ReactElement[] {
  const prefix = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ';
  const color: ThemeColor =
    line.kind === 'add'
      ? colors.exec
      : line.kind === 'del'
        ? colors.error
        : colors.dim;
  const segments = softWrap(`${prefix}${line.text}`, Math.max(20, width - 4));
  return segments.map((segment, idx) => (
    <Text
      key={`${keyPrefix}-${idx}`}
      color={color}
      dimColor={line.kind === 'ctx'}
    >
      {segment}
    </Text>
  ));
}

function renderDiffHunk(
  hunk: DiffHunk,
  width: number,
  keyPrefix: string,
): ReactElement {
  if (hunk.kind === 'truncated') {
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={colors.error} dimColor>
          {`… diff truncated: ${hunk.oldBytes}B → ${hunk.newBytes}B exceeds the 50KB cap`}
        </Text>
      </Box>
    );
  }
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  const collapsed = collapseHunkLines(hunk.lines);
  return (
    <Box key={keyPrefix} flexDirection="column">
      <Text color={colors.dim} dimColor>
        {header}
      </Text>
      {collapsed.collapsed
        ? [
            ...collapsed.head.flatMap((line, i) =>
              renderDiffLine(line, width, `${keyPrefix}-h-${i}`),
            ),
            <Text key={`${keyPrefix}-hidden`} color={colors.dim} dimColor>
              {`  … ${collapsed.hiddenCount} lines hidden`}
            </Text>,
            ...collapsed.tail.flatMap((line, i) =>
              renderDiffLine(line, width, `${keyPrefix}-t-${i}`),
            ),
          ]
        : collapsed.lines.flatMap((line, i) =>
            renderDiffLine(line, width, `${keyPrefix}-l-${i}`),
          )}
    </Box>
  );
}

function DiffBlock({
  payload,
  path,
  width,
  keyPrefix,
}: {
  payload: DiffPayload;
  path: string;
  width: number;
  keyPrefix: string;
}) {
  if (payload.identical || payload.hunks.length === 0) return null;
  const headerLabel = payload.created
    ? `${truncatePath(path, Math.max(20, width - 16))}  (new file)`
    : truncatePath(path, Math.max(20, width - 4));
  return (
    <Box flexDirection="column" marginLeft={6}>
      <Text color={colors.dim} dimColor>
        {headerLabel}
      </Text>
      {payload.hunks.map((hunk, i) =>
        renderDiffHunk(hunk, width - 6, `${keyPrefix}-${i}`),
      )}
    </Box>
  );
}

function summarizeArgs(
  input: Record<string, unknown>,
  cap: number = 60,
): string {
  const limit = Math.max(20, cap);
  const keys = ['filePath', 'pattern', 'command'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && (input[k] as string).length > 0) {
      const v = input[k] as string;
      return v.length > limit ? `${v.slice(0, limit - 3)}…` : v;
    }
  }
  return '';
}

export function ToolGroupCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'tool-group' }>;
  width: number;
}) {
  const totalMs = cell.tools.reduce(
    (acc, t) => acc + ((t.endedAt ?? Date.now()) - t.startedAt),
    0,
  );
  const rowWidth = Math.max(20, width - 2);
  const toolsLabel = `${cell.tools.length} tool${cell.tools.length === 1 ? '' : 's'}`;
  const argCap = Math.max(60, rowWidth - 18);

  if (!cell.complete) {
    // Derive spinner frame from wall clock so the parent's 80ms re-render tick
    // is enough to animate it — no per-cell state needed.
    const frame =
      glyphs.spinnerFrames[
        Math.floor(Date.now() / 80) % glyphs.spinnerFrames.length
      ] ?? '⠋';
    const total = cell.tools.length;
    const activeIdx = cell.tools.findIndex((t) => !t.result);
    if (total === 0) {
      return (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginTop={1}
          marginBottom={1}
        >
          <Box flexDirection="row" width={rowWidth}>
            <Text color={colors.tool}>{`${frame}  thinking…`}</Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
        {cell.tools.map((entry, i) => {
          const settled = Boolean(entry.result);
          const isActive = i === activeIdx;
          const nameColor: ThemeColor = !settled
            ? isActive
              ? colors.tool
              : colors.dim
            : entry.result?.isError
              ? colors.error
              : colors.exec;
          const elapsed = (entry.endedAt ?? Date.now()) - entry.startedAt;
          const args = summarizeArgs(entry.call.input, argCap);
          const leader = settled ? '   ' : isActive ? `${frame}  ` : '·  ';
          return (
            <Box key={i} flexDirection="row" width={rowWidth}>
              <Text color={isActive ? colors.tool : colors.dim}>{leader}</Text>
              <Text color={nameColor}>{entry.call.toolName.padEnd(6)}</Text>
              <Box flexGrow={1} flexShrink={1} overflowX="hidden">
                <Text color="gray" wrap="truncate-end">
                  {`   ${args}`}
                </Text>
              </Box>
              <Text color="gray" dimColor>
                {formatDuration(elapsed)}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (cell.collapsed) {
    return (
      <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
        <Text color={colors.tool} dimColor>
          {`▸ ran ${toolsLabel} · ${formatDuration(totalMs)}   (⌃T expand)`}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1} marginBottom={1}>
      <Box flexDirection="row" width={rowWidth}>
        <Text color={colors.tool}>{`ran ${toolsLabel}`}</Text>
        <Box flexGrow={1} />
        <Text color={colors.tool} dimColor>
          {formatDuration(totalMs)}
        </Text>
      </Box>
      {cell.tools.map((entry, i) => {
        const elapsed = (entry.endedAt ?? Date.now()) - entry.startedAt;
        const nameColor: ThemeColor = !entry.result
          ? colors.tool
          : entry.result.isError
            ? colors.error
            : colors.exec;
        const args = summarizeArgs(entry.call.input, argCap);
        const diffInfo = extractDiff(entry.result);
        return (
          <Box key={i} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" width={rowWidth}>
              <Text color={nameColor}>{entry.call.toolName.padEnd(6)}</Text>
              <Box flexGrow={1} flexShrink={1} overflowX="hidden">
                <Text color="gray" wrap="truncate-end">
                  {`   ${args}`}
                </Text>
              </Box>
              <Text color="gray" dimColor>
                {formatDuration(elapsed)}
              </Text>
            </Box>
            {diffInfo && (
              <DiffBlock
                payload={diffInfo.diff}
                path={diffInfo.path}
                width={width}
                keyPrefix={`diff-${i}`}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function BashDirectCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'bash-direct' }>;
  width: number;
}) {
  const stdoutLines = cell.stdout
    .split('\n')
    .filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0);
  const stderrLines = cell.stderr
    .split('\n')
    .filter((line, idx, arr) => idx < arr.length - 1 || line.length > 0);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text color={colors.bash}>{`${glyphs.bash}  `}</Text>
        <Text color={colors.bash}>{cell.command}</Text>
      </Box>
      {stdoutLines.length > 0 && (
        <Box flexDirection="column" marginLeft={3}>
          {stdoutLines.flatMap((line, i) =>
            softWrap(line, Math.max(20, width - 6)).map((seg, j) => (
              <Text key={`o-${i}-${j}`} color="white">
                {seg}
              </Text>
            )),
          )}
        </Box>
      )}
      {stderrLines.length > 0 && (
        <Box flexDirection="column" marginLeft={3}>
          {stderrLines.flatMap((line, i) =>
            softWrap(line, Math.max(20, width - 6)).map((seg, j) => (
              <Text key={`e-${i}-${j}`} color={colors.error}>
                {seg}
              </Text>
            )),
          )}
        </Box>
      )}
      <Box marginLeft={3}>
        <Text color="gray" dimColor>
          {`exit ${cell.exitCode}  ·  ${formatDuration(cell.durationMs)}`}
        </Text>
      </Box>
    </Box>
  );
}

export function ErrorCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'error' }>;
  width: number;
}) {
  const wrapped = cell.detail
    .split('\n')
    .flatMap((line) => softWrap(line, Math.max(20, width - 8)));
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.error}
        paddingX={1}
      >
        <Text color={colors.error}>{`error · ${cell.title}`}</Text>
        {wrapped.map((line, i) => (
          <Text key={i} color="white">
            {line}
          </Text>
        ))}
        {cell.actionsHint && (
          <Text color="gray" dimColor>
            {cell.actionsHint}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function PlanNoteCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'plan-note' }>;
  width: number;
}) {
  const wrapped = cell.text
    .split('\n')
    .flatMap((line) => softWrap(line, Math.max(20, width - 4)));
  return (
    <Box flexDirection="column" marginBottom={1}>
      {wrapped.map((line, i) => (
        <Box key={i} flexDirection="row">
          {i === 0 ? gutter(glyphs.plan, colors.plan) : <Text>{'  '}</Text>}
          <Text color={colors.plan}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function TodoCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'todo' }>;
  width: number;
}) {
  const innerWidth = Math.max(20, width - 6);
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={colors.plan}>
        {`${glyphs.plan} plan · ${cell.todos.length} item${cell.todos.length === 1 ? '' : 's'}`}
      </Text>
      {cell.todos.length === 0 ? (
        <Text color={colors.dim} dimColor>
          (cleared)
        </Text>
      ) : (
        cell.todos.map((item) => {
          const glyph =
            item.status === 'completed'
              ? '[x]'
              : item.status === 'in_progress'
                ? '[~]'
                : '[ ]';
          const color: ThemeColor =
            item.status === 'in_progress'
              ? colors.accent
              : item.status === 'completed'
                ? colors.dim
                : 'white';
          const text =
            item.status === 'in_progress' && item.activeForm
              ? item.activeForm
              : item.content;
          const lines = softWrap(text, innerWidth);
          return (
            <Box key={item.id} flexDirection="row">
              <Text color={color}>{`  ${glyph} `}</Text>
              <Box flexDirection="column">
                {lines.map((line, i) => (
                  <Text
                    key={i}
                    color={color}
                    dimColor={item.status === 'completed'}
                    strikethrough={item.status === 'completed'}
                  >
                    {line}
                  </Text>
                ))}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}

export function renderCell(cell: TranscriptCell, width: number) {
  switch (cell.kind) {
    case 'user':
      return <UserCell cell={cell} width={width} />;
    case 'assistant':
      return <AssistantCell cell={cell} width={width} />;
    case 'tool-group':
      return <ToolGroupCell cell={cell} width={width} />;
    case 'bash-direct':
      return <BashDirectCell cell={cell} width={width} />;
    case 'error':
      return <ErrorCell cell={cell} width={width} />;
    case 'plan-note':
      return <PlanNoteCell cell={cell} width={width} />;
    case 'todo':
      return <TodoCell cell={cell} width={width} />;
  }
}
