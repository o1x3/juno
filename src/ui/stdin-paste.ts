const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export type PasteListener = (text: string) => void;

export type PasteHandle = {
  dispose: () => void;
};

// Attach a `data` listener to stdin that recognises bracketed-paste markers
// and emits the inner text as a single atomic event. Ink's own keypress
// listener still receives the same data, so non-paste keystrokes work
// normally — we just flag pastes for the composer to insert as one mutation
// instead of one character at a time.
//
// We deliberately do NOT toggle bracketed paste mode (\x1b[?2004h /
// \x1b[?2004l). Writing those sequences to process.stdin echoes them right
// back into our input stream and confuses Ink's keypress parser (notably
// breaking backspace handling on some terminals). Modern terminals (macOS
// Terminal, iTerm2, kitty, alacritty, recent Linux defaults) enable
// bracketed paste by default; on terminals that don't, paste falls back to
// per-character delivery, which is the same behaviour Ink had before this
// listener existed.
export function attachPasteListener(
  stdin: NodeJS.ReadStream,
  onPaste: PasteListener,
): PasteHandle {
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
    },
  };
}

export const PASTE_MARKERS = { start: PASTE_START, end: PASTE_END };
