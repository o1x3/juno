import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { ToolCall, ToolResult } from '@/types';
import { formatDuration, softWrap } from '@/ui/format';
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
      spinnerFrame: number;
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
    };

function gutter(glyph: string, color: ThemeColor) {
  return <Text color={color}>{glyph} </Text>;
}

function CodeFenceBlock({ lang, code }: { lang: string; code: string[] }) {
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Text color="gray" dimColor>
        {`┄ ${lang || 'code'} ${'┄'.repeat(40)}`}
      </Text>
      {code.map((line, i) => (
        <Text key={i} color="cyanBright">
          {`  ${line}`}
        </Text>
      ))}
      <Text color="gray" dimColor>
        {'┄'.repeat(40 + (lang || 'code').length + 4)}
      </Text>
    </Box>
  );
}

function renderAssistantWithFences(text: string, width: number): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fenceMatch = line.match(/^```\s*(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? '';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').match(/^```\s*$/)) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // skip closing fence
      out.push(<CodeFenceBlock key={key++} lang={lang} code={code} />);
      continue;
    }
    if (line.length === 0) {
      out.push(<Text key={key++}> </Text>);
      i += 1;
      continue;
    }
    const wrapped = softWrap(line, Math.max(20, width - 4));
    wrapped.forEach((seg) => {
      out.push(
        <Text key={key++} color="cyanBright">
          {seg}
        </Text>,
      );
    });
    i += 1;
  }
  return out;
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
  const nodes = renderAssistantWithFences(cell.text, width);
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

function summarizeArgs(input: Record<string, unknown>): string {
  const keys = ['filePath', 'pattern', 'command'];
  for (const k of keys) {
    if (typeof input[k] === 'string' && (input[k] as string).length > 0) {
      const v = input[k] as string;
      return v.length > 60 ? `${v.slice(0, 57)}…` : v;
    }
  }
  return '';
}

export function ToolGroupCell({
  cell,
}: {
  cell: Extract<TranscriptCell, { kind: 'tool-group' }>;
}) {
  const totalMs = cell.tools.reduce(
    (acc, t) => acc + ((t.endedAt ?? Date.now()) - t.startedAt),
    0,
  );
  const header = cell.complete
    ? `▾ tools · ${cell.tools.length} call${cell.tools.length === 1 ? '' : 's'} · ${formatDuration(totalMs)}`
    : `▾ tools · ${cell.tools.length} call${cell.tools.length === 1 ? '' : 's'} · ${formatDuration(totalMs)}`;
  if (cell.collapsed && cell.complete) {
    return (
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        <Text color={colors.tool} dimColor>
          {`▸ tools · ${cell.tools.length} call${cell.tools.length === 1 ? '' : 's'} · ${formatDuration(totalMs)}   (⌃T expand)`}
        </Text>
      </Box>
    );
  }
  const spinner =
    glyphs.spinnerFrames[cell.spinnerFrame % glyphs.spinnerFrames.length] ??
    '⠋';
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      <Text color={colors.tool}>{header}</Text>
      {cell.tools.map((entry, i) => {
        const elapsed = (entry.endedAt ?? Date.now()) - entry.startedAt;
        const status = !entry.result
          ? `${spinner}`
          : entry.result.isError
            ? '✗'
            : '✓';
        const statusColor: ThemeColor = !entry.result
          ? colors.tool
          : entry.result.isError
            ? colors.error
            : colors.exec;
        const args = summarizeArgs(entry.call.input);
        return (
          <Box key={i} flexDirection="row">
            <Text color={statusColor}>{`  ${status}  `}</Text>
            <Text color={colors.tool}>{entry.call.toolName.padEnd(6)}</Text>
            <Text color="gray">{args}</Text>
            <Text color="gray" dimColor>
              {`  ${formatDuration(elapsed)}`}
            </Text>
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

export function renderCell(cell: TranscriptCell, width: number) {
  switch (cell.kind) {
    case 'user':
      return <UserCell cell={cell} width={width} />;
    case 'assistant':
      return <AssistantCell cell={cell} width={width} />;
    case 'tool-group':
      return <ToolGroupCell cell={cell} />;
    case 'bash-direct':
      return <BashDirectCell cell={cell} width={width} />;
    case 'error':
      return <ErrorCell cell={cell} width={width} />;
    case 'plan-note':
      return <PlanNoteCell cell={cell} width={width} />;
  }
}
