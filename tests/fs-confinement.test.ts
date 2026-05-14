import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveInside, WorkspaceEscapeError } from '@/core/fs';

let workspace = '';
let outsideDir = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
  if (outsideDir) {
    await rm(outsideDir, { recursive: true, force: true });
    outsideDir = '';
  }
});

describe('resolveInside', () => {
  test('returns absolute path under root for relative input', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    const realRoot = realpathSync(workspace);
    const resolved = resolveInside(workspace, 'src/foo.ts');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(join(realRoot, 'src', 'foo.ts'));
  });

  test('rejects `..` escapes with WorkspaceEscapeError', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    expect(() => resolveInside(workspace, '..')).toThrow(WorkspaceEscapeError);
    expect(() => resolveInside(workspace, '../outside.txt')).toThrow(
      /resolves outside workspace root/,
    );
  });

  test('rejects absolute paths outside the workspace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    expect(() => resolveInside(workspace, '/etc/passwd')).toThrow(
      WorkspaceEscapeError,
    );
  });

  test('accepts absolute paths inside the workspace (idempotent)', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    const first = resolveInside(workspace, 'src/foo.ts');
    const second = resolveInside(workspace, first);
    expect(second).toBe(first);
  });

  test('rejects a symlink inside the workspace that targets outside', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'juno-fs-outside-'));
    await symlink(outsideDir, join(workspace, 'escape'));
    expect(() => resolveInside(workspace, 'escape/file.txt')).toThrow(
      WorkspaceEscapeError,
    );
    expect(() => resolveInside(workspace, 'escape')).toThrow(
      WorkspaceEscapeError,
    );
  });

  test('treats empty string and `.` as the workspace root', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    const realRoot = realpathSync(workspace);
    expect(resolveInside(workspace, '')).toBe(realRoot);
    expect(resolveInside(workspace, '.')).toBe(realRoot);
  });

  test('error carries userPath and workspaceRoot for callers to inspect', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-fs-'));
    try {
      resolveInside(workspace, '../escape');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceEscapeError);
      const e = err as WorkspaceEscapeError;
      expect(e.userPath).toBe('../escape');
      expect(e.workspaceRoot).toBe(workspace);
      // Sanity: ensure resolve() would have produced a path outside the root.
      const wouldBe = resolve(workspace, '../escape');
      expect(wouldBe.startsWith(workspace)).toBe(false);
    }
  });
});
