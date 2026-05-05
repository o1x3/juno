import { Box, Text } from 'ink';
import { useMemo } from 'react';

import { renderCell, type TranscriptCell } from '@/ui/components/cells';
import { clampScroll } from '@/ui/format';
import { colors } from '@/ui/theme';

export type TranscriptScrollState = {
  scrollOffset: number;
  unreadCount: number;
  stickToBottom: boolean;
};

export type TranscriptProps = {
  cells: TranscriptCell[];
  width: number;
  height: number;
  scrollOffset: number;
  unreadCount: number;
};

// We render the last N cells where N is approximated from height. Ink lays out
// each child as it sees fit; cells choose their own line counts. We slice from
// the end based on `scrollOffset` (number of full cells skipped, not rows).
// This is a deliberately simpler model than per-row windowing — Ink already
// frames at the screen, so feeding it the right slice is enough.

export function Transcript(props: TranscriptProps) {
  const { cells, width, height, scrollOffset, unreadCount } = props;

  const visible = useMemo(() => {
    if (cells.length === 0) return [];
    const maxOffset = Math.max(0, cells.length - 1);
    const offset = clampScroll(scrollOffset, maxOffset);
    // Each cell is small; show as many as fit roughly. Pull the tail minus
    // offset, then slice to a reasonable upper bound to avoid blowing render.
    const tailEnd = cells.length - offset;
    const rough = Math.max(4, Math.floor(height / 3));
    const start = Math.max(0, tailEnd - rough * 4);
    return cells.slice(start, tailEnd);
  }, [cells, scrollOffset, height]);

  return (
    <Box flexDirection="column" width={width} flexGrow={1}>
      {scrollOffset > 0 && (
        <Box>
          <Text color={colors.dim} dimColor>
            {`↑ scrolled · press End to jump to bottom${unreadCount > 0 ? ` · ${unreadCount} new below` : ''}`}
          </Text>
        </Box>
      )}
      {visible.map((cell) => (
        <Box key={cell.id}>{renderCell(cell, width)}</Box>
      ))}
    </Box>
  );
}
