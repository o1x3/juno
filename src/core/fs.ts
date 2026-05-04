import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function resolveInside(baseDir: string, targetPath: string): string {
  const absolute = resolve(baseDir, targetPath);
  return absolute;
}

export async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}
