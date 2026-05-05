import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { softWrap } from '@/ui/format';
import { KillRing } from '@/ui/kill-ring';
import { colors, type ThemeColor } from '@/ui/theme';
import { UndoStack } from '@/ui/undo-stack';

type LastAction = 'kill-back' | 'kill-forward' | 'yank' | 'edit' | undefined;

type EditorSnapshot = {
  value: string;
  cursor: { line: number; col: number };
};

export type ComposerVisualMode = 'exec' | 'plan' | 'bash' | 'palette';

export type ComposerProps = {
  value: string;
  visualMode: ComposerVisualMode;
  width: number;
  history: string[];
  placeholder?: string;
  isActive: boolean;
  paletteOpen?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onEmptyBackspace?: () => void;
  onModeToggle?: () => void;
  onArrowUpAtTop?: () => void;
  onArrowDownAtBottom?: () => void;
  onPaletteNav?: (direction: 'up' | 'down') => void;
  onPaletteAccept?: () => void;
};

type Cursor = { line: number; col: number };

function splitLines(text: string): string[] {
  return text.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function modePrefix(mode: ComposerVisualMode): {
  glyph: string;
  color: ThemeColor;
} {
  switch (mode) {
    case 'plan':
      return { glyph: '◆', color: colors.plan };
    case 'bash':
      return { glyph: '$', color: colors.bash };
    case 'palette':
      return { glyph: '/', color: colors.accent };
    default:
      return { glyph: '▌', color: colors.accent };
  }
}

function findPrevWordBoundary(line: string, col: number): number {
  if (col <= 0) return 0;
  let i = col - 1;
  while (i > 0 && /\s/.test(line[i] ?? '')) i -= 1;
  while (i > 0 && !/\s/.test(line[i - 1] ?? '')) i -= 1;
  return i;
}

export function Composer(props: ComposerProps) {
  const {
    value,
    visualMode,
    width,
    history,
    placeholder,
    isActive,
    onChange,
    onSubmit,
    onCancel,
    onEmptyBackspace,
    onModeToggle,
    onArrowUpAtTop,
    onArrowDownAtBottom,
    onPaletteNav,
    onPaletteAccept,
    paletteOpen,
  } = props;

  const [cursor, setCursor] = useState<Cursor>({ line: 0, col: 0 });
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const killRingRef = useRef<KillRing>(new KillRing());
  const undoStackRef = useRef<UndoStack<EditorSnapshot>>(
    new UndoStack<EditorSnapshot>(),
  );
  const lastActionRef = useRef<LastAction>(undefined);
  // Draft preserved when the user starts walking through history, so ↓ past
  // the most-recent entry restores what they were composing.
  const historyDraftRef = useRef<string>('');

  const lines = useMemo(() => splitLines(value), [value]);
  const innerWidth = Math.max(10, width - 4); // leave room for border + glyph

  // Keep cursor inside bounds whenever value changes (e.g. external set).
  useEffect(() => {
    setCursor((c) => {
      const ls = splitLines(valueRef.current);
      const line = Math.min(c.line, Math.max(0, ls.length - 1));
      const col = Math.min(c.col, ls[line]?.length ?? 0);
      return line === c.line && col === c.col ? c : { line, col };
    });
  }, []);

  const apply = useCallback(
    (
      next: string,
      nextCursor: Cursor,
      opts: { snapshot?: boolean } = { snapshot: true },
    ) => {
      if (opts.snapshot !== false) {
        undoStackRef.current.push({
          value: valueRef.current,
          cursor: { ...cursorRef.current },
        });
      }
      onChange(next);
      setCursor(nextCursor);
    },
    [onChange],
  );

  const insertText = useCallback(
    (text: string) => {
      const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const ls = splitLines(valueRef.current);
      const c = cursorRef.current;
      const head = (ls[c.line] ?? '').slice(0, c.col);
      const tail = (ls[c.line] ?? '').slice(c.col);
      const inserted = splitLines(sanitized);
      let newCursor: Cursor;
      let newLines: string[];
      const firstChunk = inserted[0] ?? '';
      const lastChunk = inserted[inserted.length - 1] ?? '';
      if (inserted.length === 1) {
        newLines = [...ls];
        newLines[c.line] = head + firstChunk + tail;
        newCursor = { line: c.line, col: head.length + firstChunk.length };
      } else {
        const before = ls.slice(0, c.line);
        const after = ls.slice(c.line + 1);
        const first = head + firstChunk;
        const middle = inserted.slice(1, -1);
        const last = lastChunk + tail;
        newLines = [...before, first, ...middle, last, ...after];
        newCursor = {
          line: c.line + inserted.length - 1,
          col: lastChunk.length,
        };
      }
      apply(joinLines(newLines), newCursor);
    },
    [apply],
  );

  // Bracketed-paste detection used to attach a second `data` listener to
  // process.stdin. Under Bun + macOS Terminal that listener seemed to interact
  // with Ink's own stdin reader (raw `\x7f` = backspace stopped firing) so
  // the listener is disabled. Multi-line paste falls back to per-character
  // delivery; long lines may submit prematurely on lines that contain raw
  // newlines, but the buffer/cursor stays consistent. We can revisit using
  // a full StdinBuffer-style state machine that owns stdin instead of
  // sharing it with Ink.

  const submitCurrent = useCallback(() => {
    const text = valueRef.current;
    if (text.trim().length === 0) return;
    onSubmit(text);
    setHistoryIdx(-1);
    setCursor({ line: 0, col: 0 });
  }, [onSubmit]);

  const moveTo = useCallback((c: Cursor) => setCursor(c), []);

  const isAtTop = (c: Cursor) => c.line === 0;
  const isAtBottom = (c: Cursor, ls: string[]) => c.line === ls.length - 1;

  useInput(
    (input, key) => {
      const ls = splitLines(valueRef.current);
      const c = cursorRef.current;

      // Some terminals send DEL (0x7f) or BS (0x08) for the backspace key
      // without triggering Ink's `key.backspace`. Detect explicitly so the
      // raw byte never falls through into the plain-input branch and gets
      // re-inserted into the buffer.
      const inputCode = input.length === 1 ? input.charCodeAt(0) : -1;
      const isBackspace =
        key.backspace || inputCode === 0x7f || inputCode === 0x08;
      const isDelete = key.delete;

      // Cancel/exit: bubble up.
      if (key.escape) {
        onCancel?.();
        return;
      }

      // Palette navigation: ↑/↓ cycle items, Tab accepts highlighted.
      if (paletteOpen) {
        if (key.tab && !key.shift) {
          onPaletteAccept?.();
          return;
        }
        if (key.upArrow) {
          onPaletteNav?.('up');
          return;
        }
        if (key.downArrow) {
          onPaletteNav?.('down');
          return;
        }
      }

      // Mode toggle (Shift+Tab).
      if (key.tab && key.shift) {
        onModeToggle?.();
        return;
      }

      // Submit on Enter.
      if (key.return && !key.shift && !key.meta) {
        submitCurrent();
        return;
      }

      // Newline on Ctrl+J.
      if (key.ctrl && input === 'j') {
        const head = (ls[c.line] ?? '').slice(0, c.col);
        const tail = (ls[c.line] ?? '').slice(c.col);
        const next = [
          ...ls.slice(0, c.line),
          head,
          tail,
          ...ls.slice(c.line + 1),
        ];
        apply(joinLines(next), { line: c.line + 1, col: 0 });
        return;
      }

      // Backspace: at empty composer + bash/palette mode → exit.
      if (isBackspace || isDelete) {
        lastActionRef.current = 'edit';
        if (valueRef.current.length === 0) {
          onEmptyBackspace?.();
          return;
        }
        if (isDelete && !isBackspace) {
          // Delete forward (Ctrl+D too)
          const cur = ls[c.line] ?? '';
          if (c.col < cur.length) {
            const next = [...ls];
            next[c.line] = cur.slice(0, c.col) + cur.slice(c.col + 1);
            apply(joinLines(next), c);
          } else if (c.line < ls.length - 1) {
            const next = [...ls];
            next[c.line] = (ls[c.line] ?? '') + (ls[c.line + 1] ?? '');
            next.splice(c.line + 1, 1);
            apply(joinLines(next), c);
          }
          return;
        }
        // Backspace
        if (c.col > 0) {
          const cur = ls[c.line] ?? '';
          const next = [...ls];
          next[c.line] = cur.slice(0, c.col - 1) + cur.slice(c.col);
          apply(joinLines(next), { line: c.line, col: c.col - 1 });
        } else if (c.line > 0) {
          const prev = ls[c.line - 1] ?? '';
          const cur = ls[c.line] ?? '';
          const next = [
            ...ls.slice(0, c.line - 1),
            prev + cur,
            ...ls.slice(c.line + 1),
          ];
          apply(joinLines(next), { line: c.line - 1, col: prev.length });
        }
        return;
      }

      // Ctrl+W: kill previous word.
      if (key.ctrl && input === 'w') {
        const cur = ls[c.line] ?? '';
        const newCol = findPrevWordBoundary(cur, c.col);
        if (newCol === c.col) return;
        const killed = cur.slice(newCol, c.col);
        killRingRef.current.push(killed, {
          prepend: true,
          accumulate: lastActionRef.current === 'kill-back',
        });
        lastActionRef.current = 'kill-back';
        const next = [...ls];
        next[c.line] = cur.slice(0, newCol) + cur.slice(c.col);
        apply(joinLines(next), { line: c.line, col: newCol });
        return;
      }

      // Ctrl+K: kill to line end.
      if (key.ctrl && input === 'k') {
        const cur = ls[c.line] ?? '';
        if (c.col >= cur.length) return;
        const killed = cur.slice(c.col);
        killRingRef.current.push(killed, {
          prepend: false,
          accumulate: lastActionRef.current === 'kill-forward',
        });
        lastActionRef.current = 'kill-forward';
        const next = [...ls];
        next[c.line] = cur.slice(0, c.col);
        apply(joinLines(next), c);
        return;
      }

      // Ctrl+U: kill to line start.
      if (key.ctrl && input === 'u') {
        const cur = ls[c.line] ?? '';
        if (c.col <= 0) return;
        const killed = cur.slice(0, c.col);
        killRingRef.current.push(killed, {
          prepend: true,
          accumulate: lastActionRef.current === 'kill-back',
        });
        lastActionRef.current = 'kill-back';
        const next = [...ls];
        next[c.line] = cur.slice(c.col);
        apply(joinLines(next), { line: c.line, col: 0 });
        return;
      }

      // Ctrl+Y: yank most-recent kill at cursor.
      if (key.ctrl && input === 'y') {
        const yank = killRingRef.current.peek();
        if (yank) {
          insertText(yank);
          lastActionRef.current = 'yank';
        }
        return;
      }

      // Alt+Y: cycle through older kills (only valid right after a yank).
      if (!key.ctrl && key.meta && input === 'y') {
        if (
          lastActionRef.current !== 'yank' ||
          killRingRef.current.length < 2
        ) {
          return;
        }
        // Replace the last yanked text with the next-older entry.
        const prev = killRingRef.current.peek() ?? '';
        killRingRef.current.rotate();
        const replacement = killRingRef.current.peek() ?? '';
        const cur = ls[c.line] ?? '';
        const back = c.col - prev.length;
        if (back < 0 || cur.slice(back, c.col) !== prev) return;
        const next = [...ls];
        next[c.line] = cur.slice(0, back) + replacement + cur.slice(c.col);
        apply(joinLines(next), {
          line: c.line,
          col: back + replacement.length,
        });
        lastActionRef.current = 'yank';
        return;
      }

      // Ctrl+Z: undo.
      if (key.ctrl && input === 'z') {
        const snap = undoStackRef.current.pop();
        if (!snap) return;
        onChange(snap.value);
        setCursor(snap.cursor);
        lastActionRef.current = undefined;
        return;
      }

      // Ctrl+A / Home
      if ((key.ctrl && input === 'a') || key.home) {
        moveTo({ line: c.line, col: 0 });
        return;
      }

      // Ctrl+E / End
      if ((key.ctrl && input === 'e') || key.end) {
        moveTo({ line: c.line, col: (ls[c.line] ?? '').length });
        return;
      }

      // Arrow movement
      if (key.leftArrow) {
        if (c.col > 0) moveTo({ line: c.line, col: c.col - 1 });
        else if (c.line > 0)
          moveTo({ line: c.line - 1, col: (ls[c.line - 1] ?? '').length });
        return;
      }
      if (key.rightArrow) {
        const cur = ls[c.line] ?? '';
        if (c.col < cur.length) moveTo({ line: c.line, col: c.col + 1 });
        else if (c.line < ls.length - 1) moveTo({ line: c.line + 1, col: 0 });
        return;
      }
      if (key.upArrow) {
        if (isAtTop(c)) {
          // history
          if (history.length === 0) return;
          if (historyIdx < 0) {
            historyDraftRef.current = valueRef.current;
          }
          const next = Math.min(history.length - 1, historyIdx + 1);
          setHistoryIdx(next);
          const item = history[history.length - 1 - next] ?? '';
          onChange(item);
          const itemLines = splitLines(item);
          setCursor({
            line: itemLines.length - 1,
            col: (itemLines[itemLines.length - 1] ?? '').length,
          });
          lastActionRef.current = undefined;
          onArrowUpAtTop?.();
        } else {
          const targetLine = c.line - 1;
          moveTo({
            line: targetLine,
            col: Math.min(c.col, (ls[targetLine] ?? '').length),
          });
        }
        return;
      }
      if (key.downArrow) {
        if (isAtBottom(c, ls)) {
          if (historyIdx <= -1) {
            onArrowDownAtBottom?.();
            return;
          }
          const next = historyIdx - 1;
          setHistoryIdx(next);
          const item =
            next < 0
              ? historyDraftRef.current
              : (history[history.length - 1 - next] ?? '');
          onChange(item);
          const itemLines = splitLines(item);
          setCursor({
            line: itemLines.length - 1,
            col: (itemLines[itemLines.length - 1] ?? '').length,
          });
          lastActionRef.current = undefined;
        } else {
          const targetLine = c.line + 1;
          moveTo({
            line: targetLine,
            col: Math.min(c.col, (ls[targetLine] ?? '').length),
          });
        }
        return;
      }

      // Plain typed character — filter control bytes that escaped earlier
      // branches (e.g. \x7f if Ink ever delivered it bare on this terminal).
      if (input && !key.ctrl && !key.meta) {
        if (input.length === 1) {
          const code = input.charCodeAt(0);
          if (code < 0x20 || code === 0x7f) return;
        }
        lastActionRef.current = 'edit';
        insertText(input);
      }
    },
    { isActive },
  );

  const prefix = modePrefix(visualMode);
  const showPlaceholder = value.length === 0 && placeholder;

  // Wrap visible lines and inject cursor.
  const renderedLines: { text: string; cursorAt?: number }[] = [];
  if (showPlaceholder) {
    renderedLines.push({ text: placeholder });
  } else {
    lines.forEach((line, lineIdx) => {
      const wrapped = softWrap(line, innerWidth);
      let charsBefore = 0;
      wrapped.forEach((segment) => {
        const segmentLen = segment.length;
        let cursorAt: number | undefined;
        if (
          lineIdx === cursor.line &&
          cursor.col >= charsBefore &&
          cursor.col <= charsBefore + segmentLen
        ) {
          cursorAt = cursor.col - charsBefore;
        }
        renderedLines.push({ text: segment, cursorAt });
        charsBefore += segmentLen;
      });
      // Empty logical line: still render an empty visible line.
      if (wrapped.length === 0) {
        renderedLines.push({
          text: '',
          cursorAt: lineIdx === cursor.line ? 0 : undefined,
        });
      }
    });
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={prefix.color}
      paddingX={1}
    >
      {renderedLines.map((line, idx) => (
        <Box key={idx} flexDirection="row">
          {idx === 0 ? (
            <Text color={prefix.color}>{`${prefix.glyph} `}</Text>
          ) : (
            <Text color="gray">{`  `}</Text>
          )}
          {showPlaceholder ? (
            <Text color="gray">{line.text}</Text>
          ) : line.cursorAt !== undefined ? (
            <Text>
              {line.text.slice(0, line.cursorAt)}
              <Text inverse>{line.text[line.cursorAt] ?? ' '}</Text>
              {line.text.slice(line.cursorAt + 1)}
            </Text>
          ) : (
            <Text>{line.text}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
