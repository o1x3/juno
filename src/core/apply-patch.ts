// Faithful TypeScript port of OpenAI Codex's `apply-patch` crate
// (ref/codex/codex-rs/apply-patch/src/{parser,seek_sequence,lib}.rs).
//
// The patch language is a stripped-down, file-oriented diff format:
//
//   *** Begin Patch
//   *** Add File: <path>
//   +new line
//   *** Delete File: <path>
//   *** Update File: <path>
//   *** Move to: <new path>      (optional)
//   @@ optional context header
//    context line
//   -removed line
//   +added line
//   *** End of File              (optional)
//   *** End Patch
//
// Parsing is lenient (matches the Rust default `ParseMode::Lenient`): it also
// accepts a heredoc wrapper (`<<EOF` / `<<'EOF'` / `<<"EOF"` … `EOF`) that some
// models emit, and tolerates leading/trailing whitespace around patch markers.
// Matching is fuzzy via `seekSequence`: exact → rstrip → trim → Unicode-folded.

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

export class ApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyPatchError';
  }
}

export type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

export type PatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | {
      kind: 'update';
      path: string;
      movePath?: string;
      chunks: UpdateFileChunk[];
    };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function checkBoundariesStrict(lines: string[]): string[] {
  const first = lines.length > 0 ? lines[0]?.trim() : undefined;
  const last = lines.length > 0 ? lines[lines.length - 1]?.trim() : undefined;
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) {
    return lines.slice(1, lines.length - 1);
  }
  if (first !== BEGIN_PATCH_MARKER) {
    throw new ApplyPatchError(
      "The first line of the patch must be '*** Begin Patch'",
    );
  }
  throw new ApplyPatchError(
    "The last line of the patch must be '*** End Patch'",
  );
}

function checkBoundariesLenient(lines: string[]): string[] {
  try {
    return checkBoundariesStrict(lines);
  } catch (strictError) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      lines.length >= 4 &&
      first !== undefined &&
      last !== undefined &&
      (first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
      last.endsWith('EOF')
    ) {
      return checkBoundariesStrict(lines.slice(1, lines.length - 1));
    }
    throw strictError;
  }
}

function parseUpdateFileChunk(
  lines: string[],
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  if (lines.length === 0) {
    throw new ApplyPatchError('Update hunk does not contain any lines');
  }

  let changeContext: string | undefined;
  let startIndex: number;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    changeContext = undefined;
    startIndex = 1;
  } else if (lines[0]?.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new ApplyPatchError(
      `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
    );
  } else {
    changeContext = undefined;
    startIndex = 0;
  }

  if (startIndex >= lines.length) {
    throw new ApplyPatchError('Update hunk does not contain any lines');
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };
  let parsed = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === EOF_MARKER) {
      if (parsed === 0) {
        throw new ApplyPatchError('Update hunk does not contain any lines');
      }
      chunk.isEndOfFile = true;
      parsed += 1;
      break;
    }
    const head = line.length > 0 ? line[0] : undefined;
    if (head === undefined) {
      // Empty line → empty in both old and new.
      chunk.oldLines.push('');
      chunk.newLines.push('');
    } else if (head === ' ') {
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
    } else if (head === '+') {
      chunk.newLines.push(line.slice(1));
    } else if (head === '-') {
      chunk.oldLines.push(line.slice(1));
    } else {
      if (parsed === 0) {
        throw new ApplyPatchError(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        );
      }
      // Start of the next hunk.
      break;
    }
    parsed += 1;
  }

  return { chunk, consumed: parsed + startIndex };
}

function parseOneHunk(lines: string[]): { hunk: PatchHunk; consumed: number } {
  const firstLine = (lines[0] ?? '').trim();

  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const path = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = '';
    let consumed = 1;
    for (let i = 1; i < lines.length; i += 1) {
      const addLine = lines[i] as string;
      if (addLine.startsWith('+')) {
        contents += `${addLine.slice(1)}\n`;
        consumed += 1;
      } else {
        break;
      }
    }
    return { hunk: { kind: 'add', path, contents }, consumed };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    return {
      hunk: {
        kind: 'delete',
        path: firstLine.slice(DELETE_FILE_MARKER.length),
      },
      consumed: 1,
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const path = firstLine.slice(UPDATE_FILE_MARKER.length);
    let rest = lines.slice(1);
    let consumed = 1;
    let movePath: string | undefined;
    if (rest[0]?.startsWith(MOVE_TO_MARKER)) {
      movePath = rest[0].slice(MOVE_TO_MARKER.length);
      rest = rest.slice(1);
      consumed += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (rest.length > 0) {
      if ((rest[0] ?? '').trim() === '') {
        consumed += 1;
        rest = rest.slice(1);
        continue;
      }
      if (rest[0]?.startsWith('*')) {
        break;
      }
      const { chunk, consumed: chunkConsumed } = parseUpdateFileChunk(
        rest,
        chunks.length === 0,
      );
      chunks.push(chunk);
      consumed += chunkConsumed;
      rest = rest.slice(chunkConsumed);
    }

    if (chunks.length === 0) {
      throw new ApplyPatchError(`Update file hunk for path '${path}' is empty`);
    }

    return {
      hunk: { kind: 'update', path, movePath, chunks },
      consumed,
    };
  }

  throw new ApplyPatchError(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

export function parsePatch(patch: string): PatchHunk[] {
  const lines = patch.trim().split('\n');
  const hunkLines = checkBoundariesLenient(lines);

  const hunks: PatchHunk[] = [];
  let remaining = hunkLines;
  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining);
    hunks.push(hunk);
    remaining = remaining.slice(consumed);
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Fuzzy line matching (seek_sequence.rs)
// ---------------------------------------------------------------------------

function normalizeUnicode(s: string): string {
  let out = '';
  for (const ch of s.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      code === 0x2010 ||
      code === 0x2011 ||
      code === 0x2012 ||
      code === 0x2013 ||
      code === 0x2014 ||
      code === 0x2015 ||
      code === 0x2212
    ) {
      out += '-';
    } else if (
      code === 0x2018 ||
      code === 0x2019 ||
      code === 0x201a ||
      code === 0x201b
    ) {
      out += "'";
    } else if (
      code === 0x201c ||
      code === 0x201d ||
      code === 0x201e ||
      code === 0x201f
    ) {
      out += '"';
    } else if (
      code === 0x00a0 ||
      code === 0x2002 ||
      code === 0x2003 ||
      code === 0x2004 ||
      code === 0x2005 ||
      code === 0x2006 ||
      code === 0x2007 ||
      code === 0x2008 ||
      code === 0x2009 ||
      code === 0x200a ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000
    ) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/u, '');
}

export function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;
  const last = lines.length - pattern.length;

  // Exact.
  for (let i = searchStart; i <= last; i += 1) {
    let ok = true;
    for (let p = 0; p < pattern.length; p += 1) {
      if (lines[i + p] !== pattern[p]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  // rstrip.
  for (let i = searchStart; i <= last; i += 1) {
    let ok = true;
    for (let p = 0; p < pattern.length; p += 1) {
      if (trimEnd(lines[i + p] as string) !== trimEnd(pattern[p] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  // trim both sides.
  for (let i = searchStart; i <= last; i += 1) {
    let ok = true;
    for (let p = 0; p < pattern.length; p += 1) {
      if ((lines[i + p] as string).trim() !== (pattern[p] as string).trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  // Unicode-folded.
  for (let i = searchStart; i <= last; i += 1) {
    let ok = true;
    for (let p = 0; p < pattern.length; p += 1) {
      if (
        normalizeUnicode(lines[i + p] as string) !==
        normalizeUnicode(pattern[p] as string)
      ) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Applying an Update hunk to file text
// ---------------------------------------------------------------------------

type Replacement = { start: number; oldLen: number; newSegment: string[] };

function computeReplacements(
  originalLines: string[],
  path: string,
  chunks: UpdateFileChunk[],
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const idx = seekSequence(
        originalLines,
        [chunk.changeContext],
        lineIndex,
        false,
      );
      if (idx === undefined) {
        throw new ApplyPatchError(
          `Failed to find context '${chunk.changeContext}' in ${path}`,
        );
      }
      lineIndex = idx + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 &&
        originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push({
        start: insertionIdx,
        oldLen: 0,
        newSegment: [...chunk.newLines],
      });
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );

    if (
      found === undefined &&
      pattern.length > 0 &&
      pattern[pattern.length - 1] === ''
    ) {
      pattern = pattern.slice(0, pattern.length - 1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, newSlice.length - 1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
      );
    }

    if (found === undefined) {
      throw new ApplyPatchError(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join('\n')}`,
      );
    }
    replacements.push({
      start: found,
      oldLen: pattern.length,
      newSegment: [...newSlice],
    });
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a.start - b.start);
  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Replacement[],
): string[] {
  const out = [...lines];
  for (let r = replacements.length - 1; r >= 0; r -= 1) {
    const { start, oldLen, newSegment } = replacements[r] as Replacement;
    for (let k = 0; k < oldLen; k += 1) {
      if (start < out.length) out.splice(start, 1);
    }
    out.splice(start, 0, ...newSegment);
  }
  return out;
}

/**
 * Apply an Update hunk's chunks to `original` file text, returning the new
 * file text. Mirrors `derive_new_contents_from_chunks`: split on `\n`, drop the
 * trailing empty element, compute + apply replacements, re-add a trailing
 * newline.
 */
export function deriveUpdatedContents(
  original: string,
  path: string,
  chunks: UpdateFileChunk[],
): string {
  const originalLines = original.split('\n');
  if (
    originalLines.length > 0 &&
    originalLines[originalLines.length - 1] === ''
  ) {
    originalLines.pop();
  }
  const replacements = computeReplacements(originalLines, path, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('');
  }
  return newLines.join('\n');
}
