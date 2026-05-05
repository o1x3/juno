import { Box, Text } from 'ink';
import type { ModelUsage } from '@/types';
import {
  formatCost,
  formatDuration,
  formatTokens,
  progressBar,
  segmentBar,
  sparkline,
} from '@/ui/format';
import { colors, contextColor, glyphs } from '@/ui/theme';

const PANE_WIDTH = 28;

export type ContextBreakdown = {
  system: number;
  user: number;
  assistant: number;
  tool: number;
};

export type StatusPaneProps = {
  mode: 'plan' | 'exec' | 'bash';
  model: string;
  contextLimit: number;
  contextUsed: number;
  estimated: boolean;
  breakdown: ContextBreakdown;
  turnUsage?: ModelUsage;
  turnDurationMs: number;
  sessionUsage?: ModelUsage;
  sessionStartedMs?: number;
  recentTurns: number[];
  toolsThisTurn: {
    name: string;
    durationMs: number;
    status: 'running' | 'ok' | 'fail';
  }[];
  cost?: number;
};

function pct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

export function StatusPane(props: StatusPaneProps) {
  const innerWidth = PANE_WIDTH - 2;
  const ctxPct = pct(props.contextUsed, props.contextLimit);
  const ctxColor = contextColor(ctxPct);
  const totals = Math.max(
    1,
    props.breakdown.system +
      props.breakdown.user +
      props.breakdown.assistant +
      props.breakdown.tool,
  );
  const segments = segmentBar(
    [
      props.breakdown.system,
      props.breakdown.user,
      props.breakdown.assistant,
      props.breakdown.tool,
    ],
    innerWidth - 2,
  );
  const segGlyph = glyphs.segmentFilled;
  const sessionElapsed = props.sessionStartedMs
    ? Date.now() - props.sessionStartedMs
    : 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.dim}
      paddingX={1}
      width={PANE_WIDTH}
    >
      <Text color={colors.dim}>{'context'}</Text>
      <Box flexDirection="row">
        <Text color={ctxColor}>{progressBar(ctxPct, innerWidth - 6)}</Text>
        <Text color={ctxColor}>{` ${Math.round(ctxPct)}%`}</Text>
      </Box>
      <Text color={colors.dim} dimColor>
        {`${props.estimated ? '~' : ''}${formatTokens(props.contextUsed)} / ${formatTokens(props.contextLimit)}`}
      </Text>
      <Text> </Text>
      <Text color={colors.dim}>{'breakdown'}</Text>
      <Box flexDirection="row">
        <Text color="blueBright">
          {segGlyph.repeat(segments.lengths[0] ?? 0)}
        </Text>
        <Text color="greenBright">
          {segGlyph.repeat(segments.lengths[1] ?? 0)}
        </Text>
        <Text color="magentaBright">
          {segGlyph.repeat(segments.lengths[2] ?? 0)}
        </Text>
        <Text color="yellowBright">
          {segGlyph.repeat(segments.lengths[3] ?? 0)}
        </Text>
      </Box>
      <Text color="blueBright">
        {`${segGlyph} system    ${Math.round((props.breakdown.system / totals) * 100)}%`}
      </Text>
      <Text color="greenBright">
        {`${segGlyph} user      ${Math.round((props.breakdown.user / totals) * 100)}%`}
      </Text>
      <Text color="magentaBright">
        {`${segGlyph} assistant ${Math.round((props.breakdown.assistant / totals) * 100)}%`}
      </Text>
      <Text color="yellowBright">
        {`${segGlyph} tool      ${Math.round((props.breakdown.tool / totals) * 100)}%`}
      </Text>
      <Text> </Text>
      <Text color={colors.dim}>{'this turn'}</Text>
      {props.turnUsage ? (
        <>
          <Text>
            <Text color={colors.dim}>{'↑ '}</Text>
            {formatTokens(props.turnUsage.input)}
            <Text color={colors.dim}>{'  ↓ '}</Text>
            {formatTokens(props.turnUsage.output)}
          </Text>
          <Text color={colors.dim} dimColor>
            {`⏱ ${formatDuration(props.turnDurationMs)}`}
          </Text>
        </>
      ) : (
        <Text color={colors.dim} dimColor>
          {'idle'}
        </Text>
      )}
      <Text> </Text>
      <Text color={colors.dim}>{'session'}</Text>
      {props.sessionUsage ? (
        <>
          <Text>
            <Text color={colors.dim}>{'↑ '}</Text>
            {formatTokens(props.sessionUsage.input)}
            <Text color={colors.dim}>{'  ↓ '}</Text>
            {formatTokens(props.sessionUsage.output)}
          </Text>
          {(props.sessionUsage.cacheRead || props.sessionUsage.cacheWrite) && (
            <Text>
              <Text color={colors.dim}>{'R '}</Text>
              {formatTokens(props.sessionUsage.cacheRead ?? 0)}
              <Text color={colors.dim}>{'  W '}</Text>
              {formatTokens(props.sessionUsage.cacheWrite ?? 0)}
            </Text>
          )}
          <Text>
            <Text color={colors.dim}>{'$ '}</Text>
            {formatCost(props.cost ?? 0)}
            <Text color={colors.dim}>{'  ⏱ '}</Text>
            {formatDuration(sessionElapsed)}
          </Text>
        </>
      ) : (
        <Text color={colors.dim} dimColor>
          {'no usage yet'}
        </Text>
      )}
      <Text> </Text>
      {props.recentTurns.length > 0 && (
        <>
          <Text
            color={colors.dim}
          >{`last ${Math.min(props.recentTurns.length, 6)} turns`}</Text>
          <Text color="cyanBright">
            {sparkline(props.recentTurns, 6)}
            <Text color={colors.dim} dimColor>
              {`  avg ${formatTokens(props.recentTurns.reduce((a, b) => a + b, 0) / props.recentTurns.length)}`}
            </Text>
          </Text>
          <Text> </Text>
        </>
      )}
      {props.toolsThisTurn.length > 0 && (
        <>
          <Text color={colors.dim}>{'tools (turn)'}</Text>
          {props.toolsThisTurn.map((t, i) => (
            <Text key={i}>
              <Text
                color={
                  t.status === 'running'
                    ? colors.tool
                    : t.status === 'fail'
                      ? colors.error
                      : colors.exec
                }
              >
                {t.status === 'running' ? '⠋' : t.status === 'fail' ? '✗' : '✓'}
              </Text>
              <Text>{` ${t.name.padEnd(6)}`}</Text>
              <Text color={colors.dim} dimColor>
                {formatDuration(t.durationMs)}
              </Text>
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}

export const STATUS_PANE_WIDTH = PANE_WIDTH;
