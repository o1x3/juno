export type DiffLine =
  | { kind: 'ctx'; oldLine: number; newLine: number; text: string }
  | { kind: 'add'; newLine: number; text: string }
  | { kind: 'del'; oldLine: number; text: string };

export type DiffHunk =
  | {
      kind: 'change';
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: DiffLine[];
    }
  | {
      kind: 'truncated';
      reason: 'oversize';
      oldBytes: number;
      newBytes: number;
    };

export type DiffPayload = {
  hunks: DiffHunk[];
  created?: boolean;
  identical?: boolean;
};

export const DIFF_MAX_BYTES = 50 * 1024;
export const DIFF_CONTEXT = 3;

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const parts = s.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function lcsTable(a: string[], b: string[]): Uint32Array {
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowBase = i * stride;
    const nextRowBase = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[rowBase + j] = dp[nextRowBase + (j + 1)] + 1;
      } else {
        const down = dp[nextRowBase + j];
        const right = dp[rowBase + (j + 1)];
        dp[rowBase + j] = down >= right ? down : right;
      }
    }
  }
  return dp;
}

function buildOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    const ops: DiffLine[] = [];
    for (let j = 0; j < m; j += 1) {
      const text = b[j] ?? '';
      ops.push({ kind: 'add', newLine: j + 1, text });
    }
    return ops;
  }
  if (m === 0) {
    const ops: DiffLine[] = [];
    for (let i = 0; i < n; i += 1) {
      const text = a[i] ?? '';
      ops.push({ kind: 'del', oldLine: i + 1, text });
    }
    return ops;
  }
  const dp = lcsTable(a, b);
  const stride = m + 1;
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? '';
    const bj = b[j] ?? '';
    if (ai === bj) {
      ops.push({ kind: 'ctx', oldLine: i + 1, newLine: j + 1, text: ai });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      ops.push({ kind: 'del', oldLine: i + 1, text: ai });
      i += 1;
    } else {
      ops.push({ kind: 'add', newLine: j + 1, text: bj });
      j += 1;
    }
  }
  while (i < n) {
    const text = a[i] ?? '';
    ops.push({ kind: 'del', oldLine: i + 1, text });
    i += 1;
  }
  while (j < m) {
    const text = b[j] ?? '';
    ops.push({ kind: 'add', newLine: j + 1, text });
    j += 1;
  }
  return ops;
}

function buildHunks(ops: DiffLine[]): DiffHunk[] {
  if (ops.length === 0) return [];
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k];
    if (op && op.kind !== 'ctx') changeIdx.push(k);
  }
  if (changeIdx.length === 0) return [];

  // Group change indices that share overlapping ±CONTEXT windows.
  const groups: Array<[number, number]> = [];
  const firstIdx = changeIdx[0] ?? 0;
  let groupStart = firstIdx;
  let groupEnd = firstIdx;
  for (let k = 1; k < changeIdx.length; k += 1) {
    const cur = changeIdx[k] ?? groupEnd;
    if (cur - groupEnd <= 2 * DIFF_CONTEXT + 1) {
      groupEnd = cur;
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = cur;
      groupEnd = cur;
    }
  }
  groups.push([groupStart, groupEnd]);

  const hunks: DiffHunk[] = [];
  for (const [s, e] of groups) {
    const from = Math.max(0, s - DIFF_CONTEXT);
    const to = Math.min(ops.length - 1, e + DIFF_CONTEXT);
    const lines = ops.slice(from, to + 1);
    let oldLines = 0;
    let newLines = 0;
    let oldStart = 0;
    let newStart = 0;
    for (const ln of lines) {
      if (ln.kind === 'add') {
        newLines += 1;
        if (newStart === 0) newStart = ln.newLine;
      } else if (ln.kind === 'del') {
        oldLines += 1;
        if (oldStart === 0) oldStart = ln.oldLine;
      } else {
        oldLines += 1;
        newLines += 1;
        if (oldStart === 0) oldStart = ln.oldLine;
        if (newStart === 0) newStart = ln.newLine;
      }
    }
    if (oldLines === 0) oldStart = 0;
    if (newLines === 0) newStart = 0;
    hunks.push({
      kind: 'change',
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
    });
  }
  return hunks;
}

export function computeLineDiff(oldText: string, newText: string): DiffPayload {
  if (oldText === newText) {
    return { hunks: [], identical: true };
  }
  const oldBytes = Buffer.byteLength(oldText, 'utf8');
  const newBytes = Buffer.byteLength(newText, 'utf8');
  if (oldBytes > DIFF_MAX_BYTES || newBytes > DIFF_MAX_BYTES) {
    return {
      hunks: [
        {
          kind: 'truncated',
          reason: 'oversize',
          oldBytes,
          newBytes,
        },
      ],
    };
  }
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = buildOps(a, b);
  return { hunks: buildHunks(ops) };
}
