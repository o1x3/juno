import { glyphs } from '@/ui/theme';

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count < 1000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function truncatePath(path: string, max: number): string {
  const home = process.env.HOME;
  let p = path;
  if (home && p.startsWith(home)) p = `~${p.slice(home.length)}`;
  if (p.length <= max) return p;
  return `…${p.slice(-(max - 1))}`;
}

export function clampScroll(offset: number, max: number): number {
  if (max <= 0) return 0;
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

export function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return (
    glyphs.filled.repeat(filled) +
    glyphs.empty.repeat(Math.max(0, width - filled))
  );
}

export function segmentBar(
  segments: number[],
  width: number,
): { lengths: number[] } {
  const total = segments.reduce((a, b) => a + b, 0);
  if (total <= 0 || width <= 0) {
    return { lengths: segments.map(() => 0) };
  }
  // Largest remainder method to land exactly on width
  const exact = segments.map((v) => (v / total) * width);
  const floored = exact.map((v) => Math.floor(v));
  let remaining = width - floored.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const lengths = [...floored];
  for (let k = 0; k < order.length && remaining > 0; k++) {
    const idx = order[k]?.i;
    if (idx === undefined) break;
    lengths[idx] = (lengths[idx] ?? 0) + 1;
    remaining -= 1;
  }
  return { lengths };
}

export function sparkline(values: number[], width = values.length): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const slice =
    values.length > width ? values.slice(values.length - width) : values;
  return slice
    .map((v) => {
      if (v <= 0) return glyphs.sparkBars[0] ?? ' ';
      const idx = Math.min(
        glyphs.sparkBars.length - 1,
        Math.max(0, Math.round((v / max) * (glyphs.sparkBars.length - 1))),
      );
      return glyphs.sparkBars[idx] ?? ' ';
    })
    .join('');
}

export function visibleWidth(s: string): number {
  // Conservative: count code points, not code units. Wide-char awareness left
  // out — terminal handles East Asian widths itself; we just need string length
  // for layout math.
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

export function softWrap(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (line.length <= width) return [line];
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const remaining = line.slice(i);
    if (remaining.length <= width) {
      out.push(remaining);
      break;
    }
    let cut = width;
    const lastSpace = remaining.slice(0, width).lastIndexOf(' ');
    if (lastSpace > 0 && lastSpace > width / 2) {
      cut = lastSpace + 1;
    }
    out.push(remaining.slice(0, cut).trimEnd());
    i += cut;
    while (line[i] === ' ') i += 1;
  }
  return out;
}
