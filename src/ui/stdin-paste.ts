import type { ReadStream } from 'node:tty';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export type PasteListener = (text: string) => void;

export type PasteHandle = {
  dispose: () => void;
};

export function attachPasteListener(
  stdin: ReadStream | NodeJS.ReadStream,
  onPaste: PasteListener,
): PasteHandle {
  // Some terminals support bracketed paste only after we ask for it.
  let enabled = false;
  if ('isTTY' in stdin && stdin.isTTY) {
    try {
      (stdin as ReadStream).write?.('\x1b[?2004h');
      enabled = true;
    } catch {
      enabled = false;
    }
  }

  let buffer = '';
  let inPaste = false;

  const dataHandler = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let i = 0;
    while (i < text.length) {
      if (!inPaste) {
        const startIdx = text.indexOf(PASTE_START, i);
        if (startIdx === -1) {
          i = text.length;
        } else {
          inPaste = true;
          i = startIdx + PASTE_START.length;
        }
      } else {
        const endIdx = text.indexOf(PASTE_END, i);
        if (endIdx === -1) {
          buffer += text.slice(i);
          i = text.length;
        } else {
          buffer += text.slice(i, endIdx);
          inPaste = false;
          if (buffer.length > 0) onPaste(buffer);
          buffer = '';
          i = endIdx + PASTE_END.length;
        }
      }
    }
  };

  stdin.on('data', dataHandler);

  return {
    dispose: () => {
      stdin.off('data', dataHandler);
      if (enabled && 'isTTY' in stdin && stdin.isTTY) {
        try {
          (stdin as ReadStream).write?.('\x1b[?2004l');
        } catch {
          // ignore
        }
      }
    },
  };
}

export const PASTE_MARKERS = { start: PASTE_START, end: PASTE_END };
