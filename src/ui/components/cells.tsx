import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { DiffHunk, DiffLine, DiffPayload } from '@/core/diff';
import type {
  ApprovalPreview,
  QuestionOption,
  QuestionResponse,
  TodoItem,
  ToolCall,
  ToolName,
  ToolResult,
} from '@/types';
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
      collapsed?: boolean;
    }
  | {
      id: string;
      kind: 'approval';
      toolName: ToolName;
      preview: ApprovalPreview;
      status: 'pending' | 'approved' | 'approved_forever' | 'rejected';
      selectedIndex: number;
      feedback: string;
      focusMode: 'options' | 'feedback';
      rejectionReason?: string;
      expandDiff?: boolean;
    }
  | {
      id: string;
      kind: 'question';
      questionId: string;
      question: string;
      header?: string;
      options: QuestionOption[];
      multiSelect: boolean;
      status: 'pending' | 'answered' | 'dismissed';
      selectedIndices: number[];
      focusMode: 'options' | 'notes';
      notes: string;
      cursor: number;
      answer?: QuestionResponse;
      isSecret?: boolean;
      progress?: { current: number; total: number };
    }
  | {
      id: string;
      kind: 'confirmation';
      title: string;
      body: string;
      status: 'pending' | 'confirmed' | 'cancelled';
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
  expand = false,
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
  const collapsed = expand
    ? ({ collapsed: false, lines: hunk.lines } as const)
    : collapseHunkLines(hunk.lines);
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
              {`  … ${collapsed.hiddenCount} lines hidden (⌃F expand)`}
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
  expand = false,
  marginLeft = 6,
}: {
  payload: DiffPayload;
  path: string;
  width: number;
  keyPrefix: string;
  expand?: boolean;
  marginLeft?: number;
}) {
  if (payload.identical || payload.hunks.length === 0) return null;
  const headerLabel = payload.created
    ? `${truncatePath(path, Math.max(20, width - 16))}  (new file)`
    : truncatePath(path, Math.max(20, width - 4));
  return (
    <Box flexDirection="column" marginLeft={marginLeft}>
      <Text color={colors.dim} dimColor>
        {headerLabel}
      </Text>
      {payload.hunks.map((hunk, i) =>
        renderDiffHunk(hunk, width - marginLeft, `${keyPrefix}-${i}`, expand),
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

export function summarizePlanCounts(todos: TodoItem[]): {
  pending: number;
  in_progress: number;
  completed: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === 'completed') completed += 1;
    else if (t.status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return { pending, in_progress: inProgress, completed };
}

function todoChip(todos: TodoItem[]): string {
  if (todos.length === 0) return `${glyphs.plan} plan · (cleared)`;
  const { in_progress, completed } = summarizePlanCounts(todos);
  return `${glyphs.plan} plan · ${completed}/${todos.length} done · ${in_progress} active   (⌃P expand)`;
}

export function TodoCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'todo' }>;
  width: number;
}) {
  if (cell.collapsed) {
    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Text color={colors.plan} dimColor>
          {todoChip(cell.todos)}
        </Text>
      </Box>
    );
  }

  const innerWidth = Math.max(20, width - 6);
  const counts = summarizePlanCounts(cell.todos);
  const headerSuffix =
    cell.todos.length === 0
      ? ''
      : `  ·  ${counts.completed}/${cell.todos.length} done · ${counts.in_progress} active`;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={colors.plan}>
        {`${glyphs.plan} plan · ${cell.todos.length} item${cell.todos.length === 1 ? '' : 's'}${headerSuffix}`}
      </Text>
      {cell.todos.length === 0 ? (
        <Text color={colors.dim} dimColor>
          (cleared)
        </Text>
      ) : (
        cell.todos.map((item) => {
          const glyph =
            item.status === 'completed'
              ? glyphs.optionDone
              : item.status === 'in_progress'
                ? glyphs.optionInProgress
                : glyphs.optionPending;
          const glyphColor: ThemeColor =
            item.status === 'completed'
              ? colors.exec
              : item.status === 'in_progress'
                ? colors.warn
                : colors.dim;
          const textColor: ThemeColor =
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
              <Text color={glyphColor}>{`  ${glyph} `}</Text>
              <Box flexDirection="column">
                {lines.map((line, i) => (
                  <Text
                    key={i}
                    color={textColor}
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

function approvalIcon(preview: ApprovalPreview): string {
  switch (preview.kind) {
    case 'write':
      return glyphs.approvalWrite;
    case 'edit':
      return glyphs.approvalEdit;
    case 'multi-edit':
      return glyphs.approvalMultiEdit;
    case 'bash':
      return glyphs.approvalBash;
    case 'mcp':
      return glyphs.approvalBash;
  }
}

function approvalSubtitle(preview: ApprovalPreview, width: number): string {
  const limit = Math.max(20, width - 16);
  switch (preview.kind) {
    case 'write':
      return `${preview.created ? 'Write (new) ' : 'Write '}${truncatePath(preview.path, limit)}`;
    case 'edit':
      return `Edit ${truncatePath(preview.path, limit)}`;
    case 'multi-edit':
      return `MultiEdit ${preview.created ? '(new) ' : ''}${truncatePath(preview.path, limit)}`;
    case 'bash':
      return `Bash`;
    case 'mcp':
      return `MCP ${preview.server}/${preview.tool}`;
  }
}

const APPROVAL_OPTIONS: { label: string; key: string; hint: string }[] = [
  { label: 'Approve', key: 'y', hint: 'just this once' },
  { label: 'Approve always', key: 'a', hint: 'remember for this project' },
  { label: 'Reject', key: 'n', hint: 'block this call' },
];

function approvalStatusLine(
  status: Extract<TranscriptCell, { kind: 'approval' }>['status'],
): { text: string; color: ThemeColor } {
  switch (status) {
    case 'pending':
      return { text: 'awaiting decision…', color: colors.warn };
    case 'approved':
      return { text: 'approved', color: colors.exec };
    case 'approved_forever':
      return {
        text: 'approved (remembered for this project)',
        color: colors.exec,
      };
    case 'rejected':
      return { text: 'rejected', color: colors.error };
  }
}

export function ApprovalCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'approval' }>;
  width: number;
}) {
  const innerWidth = Math.max(20, width - 4);
  const icon = approvalIcon(cell.preview);
  const subtitle = approvalSubtitle(cell.preview, innerWidth);
  const status = approvalStatusLine(cell.status);
  const isPending = cell.status === 'pending';

  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginTop={1}
      marginBottom={1}
      borderStyle="round"
      borderColor={isPending ? colors.warn : colors.dim}
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color={colors.warn} bold>
          {`${glyphs.warning}  Permission required`}
        </Text>
        <Box flexGrow={1} />
        <Text color={status.color} dimColor={!isPending}>
          {status.text}
        </Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color={colors.dim}>{`${icon}  `}</Text>
        <Text color={isPending ? 'white' : colors.dim} dimColor={!isPending}>
          {subtitle}
        </Text>
      </Box>

      {cell.preview.kind === 'bash' && (
        <Box flexDirection="column" marginLeft={3} marginTop={1}>
          {softWrap(cell.preview.command, Math.max(20, innerWidth - 6)).map(
            (line, i) => (
              <Text
                key={i}
                color={isPending ? colors.bash : colors.dim}
                dimColor={!isPending}
              >
                {line}
              </Text>
            ),
          )}
        </Box>
      )}

      {cell.preview.kind === 'mcp' && (
        <Box flexDirection="column" marginLeft={3} marginTop={1}>
          {softWrap(
            JSON.stringify(cell.preview.args, null, 2),
            Math.max(20, innerWidth - 6),
          )
            .slice(0, 12)
            .map((line, i) => (
              <Text key={i} color={isPending ? colors.dim : colors.dim}>
                {line}
              </Text>
            ))}
        </Box>
      )}

      {(cell.preview.kind === 'write' ||
        cell.preview.kind === 'edit' ||
        cell.preview.kind === 'multi-edit') &&
        cell.preview.diff && (
          <Box marginTop={1}>
            <DiffBlock
              payload={cell.preview.diff}
              path={cell.preview.path}
              width={cell.expandDiff ? innerWidth : innerWidth - 2}
              keyPrefix={`approval-${cell.id}`}
              expand={cell.expandDiff === true}
              marginLeft={cell.expandDiff ? 2 : 6}
            />
          </Box>
        )}

      {isPending && (
        <Box flexDirection="column" marginTop={1}>
          {APPROVAL_OPTIONS.map((opt, idx) => {
            const focused =
              cell.focusMode === 'options' && idx === cell.selectedIndex;
            return (
              <Box key={opt.key} flexDirection="row">
                <Text color={focused ? colors.accent : colors.dim}>
                  {focused ? `${glyphs.selector} ` : '  '}
                </Text>
                <Text color={focused ? colors.accent : 'white'} bold={focused}>
                  {`${idx + 1}. ${opt.label}`}
                </Text>
                <Box flexGrow={1} />
                <Text color={colors.dim} dimColor>
                  {`(${opt.key})  ${opt.hint}`}
                </Text>
              </Box>
            );
          })}
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.dim} dimColor>
              {cell.focusMode === 'feedback'
                ? 'reason (Enter to submit decision · Tab back to options · Esc reject):'
                : cell.feedback.length > 0
                  ? `reason: ${cell.feedback}   (Tab to edit)`
                  : 'optional reason for rejection (Tab to focus)'}
            </Text>
            {cell.focusMode === 'feedback' && (
              <Box flexDirection="row">
                <Text color={colors.accent}>{`${glyphs.selector} `}</Text>
                <Text color="white">
                  {cell.feedback.length > 0 ? cell.feedback : ' '}
                  {glyphs.cursor}
                </Text>
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={colors.dim} dimColor>
              {cell.focusMode === 'feedback'
                ? 'Type a reason · Enter submit · Tab back · Esc reject without reason'
                : `↑↓ select · Tab reason · ⌃F ${cell.expandDiff ? 'collapse' : 'expand'} diff · Enter confirm · Esc reject`}
            </Text>
          </Box>
        </Box>
      )}

      {!isPending && cell.rejectionReason && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.dim} dimColor>
            {`reason: ${cell.rejectionReason}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function QuestionCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'question' }>;
  width: number;
}) {
  const innerWidth = Math.max(20, width - 4);
  const isPending = cell.status === 'pending';
  const selectedSet = new Set(cell.selectedIndices);
  const ruleColor = isPending ? colors.accent : colors.dim;
  const statusLabel =
    cell.status === 'answered'
      ? 'answered'
      : cell.status === 'dismissed'
        ? 'dismissed'
        : 'awaiting answer…';
  const statusColor: ThemeColor =
    cell.status === 'answered'
      ? colors.exec
      : cell.status === 'dismissed'
        ? colors.error
        : colors.warn;

  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginTop={1}
      marginBottom={1}
      borderStyle="round"
      borderColor={ruleColor}
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color={colors.accent} bold>
          {`${glyphs.question}  ${cell.header ?? 'Question'}`}
        </Text>
        {cell.progress && (
          <Text color={colors.dim} dimColor>
            {`   Question ${cell.progress.current} of ${cell.progress.total}`}
          </Text>
        )}
        {cell.isSecret && (
          <Text color={colors.warn} dimColor>
            {'   (secret)'}
          </Text>
        )}
        <Box flexGrow={1} />
        <Text color={statusColor} dimColor={!isPending}>
          {statusLabel}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {softWrap(cell.question, innerWidth).map((line, i) => (
          <Text
            key={i}
            color={isPending ? 'white' : colors.dim}
            dimColor={!isPending}
          >
            {line}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {cell.options.map((opt, idx) => {
          const focused =
            isPending && cell.focusMode === 'options' && idx === cell.cursor;
          const checked = selectedSet.has(idx);
          const mark = cell.multiSelect
            ? checked
              ? '[x]'
              : '[ ]'
            : checked
              ? `${glyphs.optionDone}  `
              : '   ';
          const color = focused
            ? colors.accent
            : checked
              ? colors.exec
              : 'white';
          return (
            <Box key={idx} flexDirection="column">
              <Box flexDirection="row">
                <Text color={focused ? colors.accent : colors.dim}>
                  {focused ? `${glyphs.selector} ` : '  '}
                </Text>
                <Text color={color} bold={focused}>
                  {`${idx + 1}. ${mark} ${opt.label}`}
                </Text>
              </Box>
              {opt.description && (
                <Box flexDirection="column" marginLeft={6}>
                  {softWrap(opt.description, Math.max(20, innerWidth - 6)).map(
                    (line, i) => (
                      <Text key={i} color={colors.dim} dimColor>
                        {line}
                      </Text>
                    ),
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {isPending && cell.focusMode === 'notes' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.dim} dimColor>
            {cell.isSecret
              ? 'secret (input hidden — Enter to submit, Tab back to options):'
              : 'notes (Enter to submit, Tab back to options):'}
          </Text>
          <Box flexDirection="row">
            <Text color={colors.accent}>{`${glyphs.selector} `}</Text>
            <Text color="white">
              {cell.notes.length > 0
                ? cell.isSecret
                  ? '*'.repeat(cell.notes.length)
                  : cell.notes
                : ' '}
              {isPending && cell.focusMode === 'notes' ? glyphs.cursor : ''}
            </Text>
          </Box>
        </Box>
      )}

      {cell.status === 'answered' && cell.answer?.kind === 'answered' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.exec}>
            {`${glyphs.optionDone}  ${cell.answer.selected.join(', ')}`}
            {cell.answer.custom
              ? cell.isSecret
                ? ` — ${'*'.repeat(cell.answer.custom.length)}`
                : ` — ${cell.answer.custom}`
              : ''}
          </Text>
        </Box>
      )}

      {isPending && (
        <Box marginTop={1}>
          <Text color={colors.dim} dimColor>
            {cell.multiSelect
              ? '1-4 toggle · ↑↓ navigate · Tab notes · Enter submit · Esc cancel'
              : '1-4 select · ↑↓ navigate · Tab notes · Enter submit · Esc cancel'}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function ConfirmationCell({
  cell,
  width,
}: {
  cell: Extract<TranscriptCell, { kind: 'confirmation' }>;
  width: number;
}) {
  const innerWidth = Math.max(20, width - 6);
  const isPending = cell.status === 'pending';
  const statusLabel =
    cell.status === 'confirmed'
      ? 'confirmed'
      : cell.status === 'cancelled'
        ? 'cancelled'
        : 'awaiting decision…';
  const statusColor: ThemeColor =
    cell.status === 'confirmed'
      ? colors.yolo
      : cell.status === 'cancelled'
        ? colors.dim
        : colors.warn;
  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginTop={1}
      marginBottom={1}
      borderStyle="round"
      borderColor={isPending ? colors.yolo : colors.dim}
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color={colors.yolo} bold>
          {`${glyphs.error}  ${cell.title}`}
        </Text>
        <Box flexGrow={1} />
        <Text color={statusColor} dimColor={!isPending}>
          {statusLabel}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {cell.body.split('\n').flatMap((line, i) =>
          softWrap(line, innerWidth).map((seg, j) => (
            <Text
              key={`${i}-${j}`}
              color={isPending ? 'white' : colors.dim}
              dimColor={!isPending}
            >
              {seg}
            </Text>
          )),
        )}
      </Box>
      {isPending && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="white">
            <Text color={colors.yolo} bold>
              y
            </Text>
            {'   confirm and enter yolo'}
          </Text>
          <Text color="white">
            <Text color={colors.dim} bold>
              n
            </Text>
            {'   cancel and stay in exec'}
          </Text>
        </Box>
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
    case 'approval':
      return <ApprovalCell cell={cell} width={width} />;
    case 'question':
      return <QuestionCell cell={cell} width={width} />;
    case 'confirmation':
      return <ConfirmationCell cell={cell} width={width} />;
  }
}
