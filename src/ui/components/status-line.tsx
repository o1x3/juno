import { Box, Text } from 'ink';
import type { ModelUsage } from '@/types';
import { formatTokens } from '@/ui/format';
import { colors, glyphs } from '@/ui/theme';

export type StatusLineProps = {
  mode: 'plan' | 'exec' | 'bash' | 'yolo';
  model: string;
  streaming: boolean;
  spinnerFrame: number;
  elapsedMs: number;
  usage?: ModelUsage;
  contextLimit: number;
  sessionName?: string;
  errorCount: number;
  awaitingUser?: 'approval' | 'question' | 'confirmation' | null;
};

export function StatusLine(props: StatusLineProps) {
  const modeColor =
    props.mode === 'plan'
      ? colors.plan
      : props.mode === 'bash'
        ? colors.bash
        : props.mode === 'yolo'
          ? colors.yolo
          : colors.exec;
  const tokens = props.usage
    ? `${props.usage.estimated ? '~' : ''}${formatTokens(props.usage.input + props.usage.output)}/${formatTokens(props.contextLimit)}`
    : `0/${formatTokens(props.contextLimit)}`;
  const sec = (props.elapsedMs / 1000).toFixed(1);
  const spinner =
    glyphs.spinnerFrames[props.spinnerFrame % glyphs.spinnerFrames.length] ??
    '⠋';
  return (
    <Box flexDirection="row">
      <Text color={modeColor}>{props.mode}</Text>
      <Text color={colors.dim}>{' · '}</Text>
      <Text color={colors.accent}>{props.model}</Text>
      {props.awaitingUser ? (
        <>
          <Text color={colors.dim}>{' · '}</Text>
          <Text color={colors.warn}>
            {`⏸ awaiting ${props.awaitingUser === 'question' ? 'answer' : props.awaitingUser === 'confirmation' ? 'confirmation' : 'approval'}`}
          </Text>
        </>
      ) : (
        props.streaming && (
          <>
            <Text color={colors.dim}>{' · '}</Text>
            <Text color={colors.tool}>
              {spinner} streaming {sec}s
            </Text>
          </>
        )
      )}
      <Text color={colors.dim}>{' · '}</Text>
      <Text color={colors.dim}>{tokens}</Text>
      {props.sessionName && (
        <>
          <Text color={colors.dim}>{' · '}</Text>
          <Text color={colors.dim} dimColor>
            {props.sessionName}
          </Text>
        </>
      )}
      {props.errorCount > 0 && (
        <>
          <Text color={colors.dim}>{' · '}</Text>
          <Text
            color={colors.error}
          >{`${props.errorCount} error${props.errorCount > 1 ? 's' : ''} this turn`}</Text>
        </>
      )}
    </Box>
  );
}
