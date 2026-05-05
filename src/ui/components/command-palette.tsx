import { Box, Text } from 'ink';

import type { SlashCommand } from '@/ui/commands';
import { colors } from '@/ui/theme';

export type CommandPaletteProps = {
  items: SlashCommand[];
  selectedIndex: number;
};

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={1}
    >
      <Text color={colors.dim}>{'commands'}</Text>
      {props.items.length === 0 && (
        <Text color={colors.dim} dimColor>
          {'no matches'}
        </Text>
      )}
      {props.items.map((cmd, i) => {
        const selected = i === props.selectedIndex;
        return (
          <Box key={cmd.name} flexDirection="row">
            <Text color={selected ? colors.accent : colors.dim}>
              {selected ? '▸ ' : '  '}
            </Text>
            <Text color={selected ? 'whiteBright' : 'white'}>
              {`/${cmd.name}`.padEnd(12)}
            </Text>
            <Text color={colors.dim} dimColor>
              {cmd.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
