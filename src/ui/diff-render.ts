import type { DiffLine } from '@/core/diff';

export const HUNK_COLLAPSE_THRESHOLD = 40;
export const HUNK_HEAD_LINES = 20;
export const HUNK_TAIL_LINES = 17;

export type CollapsedHunk =
  | { collapsed: false; lines: DiffLine[] }
  | {
      collapsed: true;
      head: DiffLine[];
      tail: DiffLine[];
      hiddenCount: number;
    };

export function collapseHunkLines(lines: DiffLine[]): CollapsedHunk {
  if (lines.length <= HUNK_COLLAPSE_THRESHOLD) {
    return { collapsed: false, lines };
  }
  const head = lines.slice(0, HUNK_HEAD_LINES);
  const tail = lines.slice(lines.length - HUNK_TAIL_LINES);
  const hiddenCount = lines.length - HUNK_HEAD_LINES - HUNK_TAIL_LINES;
  return { collapsed: true, head, tail, hiddenCount };
}
