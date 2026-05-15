import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ToolName } from '@/types';

const APPROVALS_FILE = 'approvals.json';

export type ApprovalAllowlist = Record<string, ToolName[]>;

function approvalsPath(homeDir: string): string {
  return join(homeDir, APPROVALS_FILE);
}

function sanitizeStore(raw: unknown): ApprovalAllowlist {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ApprovalAllowlist = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue;
    if (!Array.isArray(value)) continue;
    const tools: ToolName[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      tools.push(item as ToolName);
    }
    out[key] = tools;
  }
  return out;
}

export async function loadApprovalAllowlist(
  homeDir: string,
): Promise<ApprovalAllowlist> {
  const path = approvalsPath(homeDir);
  try {
    const content = await readFile(path, 'utf8');
    return sanitizeStore(JSON.parse(content) as unknown);
  } catch {
    return {};
  }
}

export async function saveApprovalAllowlist(
  homeDir: string,
  store: ApprovalAllowlist,
): Promise<void> {
  const path = approvalsPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export function isToolApprovedForever(
  store: ApprovalAllowlist,
  cwd: string,
  toolName: ToolName,
): boolean {
  const entries = store[cwd];
  if (!entries) return false;
  return entries.includes(toolName);
}

export function addToolApprovalForever(
  store: ApprovalAllowlist,
  cwd: string,
  toolName: ToolName,
): ApprovalAllowlist {
  const existing = store[cwd] ?? [];
  if (existing.includes(toolName)) return store;
  return { ...store, [cwd]: [...existing, toolName] };
}
