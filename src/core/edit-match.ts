// Faithful port of opencode's Edit replacer cascade
// (ref/opencode/packages/opencode/src/tool/edit.ts). A sequence of
// progressively fuzzier matchers lets a near-miss `oldString` (whitespace,
// indentation, escaping, anchors) still resolve to a unique region before the
// edit is rejected — matching opencode's reliability behavior.

export type Replacer = (
  content: string,
  find: string,
) => Generator<string, void, unknown>;

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3;

function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = matrix[i] as number[];
      const prev = matrix[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
  }
  return (matrix[a.length] as number[])[b.length] as number;
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
};

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (
        (originalLines[i + j] as string).trim() !==
        (searchLines[j] as string).trim()
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let start = 0;
      for (let k = 0; k < i; k++)
        start += (originalLines[k] as string).length + 1;
      let end = start;
      for (let k = 0; k < searchLines.length; k++) {
        end += (originalLines[i + k] as string).length;
        if (k < searchLines.length - 1) end += 1;
      }
      yield content.substring(start, end);
    }
  }
};

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();

  const firstLineSearch = (searchLines[0] as string).trim();
  const lastLineSearch = (searchLines[searchLines.length - 1] as string).trim();
  const searchBlockSize = searchLines.length;

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if ((originalLines[i] as string).trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if ((originalLines[j] as string).trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }
  if (candidates.length === 0) return;

  const sliceOut = (startLine: number, endLine: number) => {
    let start = 0;
    for (let k = 0; k < startLine; k++)
      start += (originalLines[k] as string).length + 1;
    let end = start;
    for (let k = startLine; k <= endLine; k++) {
      end += (originalLines[k] as string).length;
      if (k < endLine) end += 1;
    }
    return content.substring(start, end);
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0] as {
      startLine: number;
      endLine: number;
    };
    const actualBlockSize = endLine - startLine + 1;
    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = (originalLines[startLine + j] as string).trim();
        const searchLine = (searchLines[j] as string).trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        similarity +=
          (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
      }
    } else {
      similarity = 1.0;
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield sliceOut(startLine, endLine);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const actualBlockSize = endLine - startLine + 1;
    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = (originalLines[startLine + j] as string).trim();
        const searchLine = (searchLines[j] as string).trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1.0;
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    yield sliceOut(bestMatch.startLine, bestMatch.endLine);
  }
};

export const WhitespaceNormalizedReplacer: Replacer = function* (
  content,
  find,
) {
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = norm(find);
  const lines = content.split('\n');
  for (const line of lines) {
    if (norm(line) === normalizedFind) {
      yield line;
    } else if (norm(line).includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words
          .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        try {
          const match = line.match(new RegExp(pattern));
          if (match) yield match[0];
        } catch {
          // invalid regex, skip
        }
      }
    }
  }
  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (norm(block.join('\n')) === normalizedFind) yield block.join('\n');
    }
  }
};

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0),
    );
    return lines
      .map((l) => (l.trim().length === 0 ? l : l.slice(minIndent)))
      .join('\n');
  };
  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) yield block;
  }
};

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeStr = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, ch) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        case "'":
          return "'";
        case '"':
          return '"';
        case '`':
          return '`';
        case '\\':
          return '\\';
        case '\n':
          return '\n';
        case '$':
          return '$';
        default:
          return match;
      }
    });
  const unescapedFind = unescapeStr(find);
  if (content.includes(unescapedFind)) yield unescapedFind;
  const lines = content.split('\n');
  const findLines = unescapedFind.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescapeStr(block) === unescapedFind) yield block;
  }
};

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) return;
  if (content.includes(trimmedFind)) yield trimmedFind;
  const lines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmedFind) yield block;
  }
};

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n');
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === '') findLines.pop();
  const contentLines = content.split('\n');
  const firstLine = (findLines[0] as string).trim();
  const lastLine = (findLines[findLines.length - 1] as string).trim();
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] as string).trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if ((contentLines[j] as string).trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1);
        const block = blockLines.join('\n');
        if (blockLines.length === findLines.length) {
          let matchingLines = 0;
          let totalNonEmpty = 0;
          for (let k = 1; k < blockLines.length - 1; k++) {
            const bl = (blockLines[k] as string).trim();
            const fl = (findLines[k] as string).trim();
            if (bl.length > 0 || fl.length > 0) {
              totalNonEmpty++;
              if (bl === fl) matchingLines++;
            }
          }
          if (totalNonEmpty === 0 || matchingLines / totalNonEmpty >= 0.5) {
            yield block;
            break;
          }
        }
        break;
      }
    }
  }
};

export class EditMatchError extends Error {
  readonly reason: 'not-found' | 'multiple' | 'identical';
  constructor(reason: 'not-found' | 'multiple' | 'identical', message: string) {
    super(message);
    this.name = 'EditMatchError';
    this.reason = reason;
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + find.length;
  }
};

const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

/**
 * Replace `oldString` with `newString` in `content`, trying progressively
 * fuzzier matchers. Throws `EditMatchError` when nothing matches, when the
 * match is ambiguous (and `replaceAll` is false), or when the strings are
 * identical. Mirrors opencode's `replace`.
 */
export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) {
    throw new EditMatchError(
      'identical',
      'No changes to apply: oldString and newString are identical.',
    );
  }
  let notFound = true;
  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;
      notFound = false;
      if (replaceAll) return content.replaceAll(search, newString);
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue;
      return (
        content.substring(0, index) +
        newString +
        content.substring(index + search.length)
      );
    }
  }
  if (notFound) {
    throw new EditMatchError(
      'not-found',
      'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings (fuzzy fallbacks also tried).',
    );
  }
  throw new EditMatchError(
    'multiple',
    'Found multiple matches for oldString. Provide more surrounding context to make the match unique.',
  );
}
