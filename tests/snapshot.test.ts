import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SnapshotStore } from '@/core/snapshot';

let workspace = '';
let home = '';

afterEach(async () => {
  for (const dir of [workspace, home]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  workspace = '';
  home = '';
});

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  await proc.exited;
}

describe('SnapshotStore', () => {
  test('enabled() only inside a git repo', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-snap-ws-'));
    expect(await SnapshotStore.enabled(workspace)).toBe(false);
    await git(['init'], workspace);
    expect(await SnapshotStore.enabled(workspace)).toBe(true);
  });

  test('create + restore reverts modifications and deletes new files', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-snap-ws-'));
    home = await mkdtemp(join(tmpdir(), 'juno-snap-home-'));
    await git(['init'], workspace);

    const fileA = join(workspace, 'a.txt');
    await writeFile(fileA, 'v1\n', 'utf8');

    const store = new SnapshotStore({ cwd: workspace, homeDir: home });
    const hash = await store.create();
    expect(hash).toBeTruthy();

    // Mutate: change A, add B.
    await writeFile(fileA, 'v2-modified\n', 'utf8');
    const fileB = join(workspace, 'b.txt');
    await writeFile(fileB, 'new file\n', 'utf8');

    const diff = await store.diff(hash as string);
    expect(diff).toContain('v2-modified');

    const restored = await store.restore(hash as string);
    expect(restored.ok).toBe(true);
    expect(await readFile(fileA, 'utf8')).toBe('v1\n');
    expect(existsSync(fileB)).toBe(false);
  });

  test('restore never deletes gitignored files', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-snap-ws-'));
    home = await mkdtemp(join(tmpdir(), 'juno-snap-home-'));
    await git(['init'], workspace);
    await writeFile(join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(join(workspace, 'tracked.txt'), 'keep\n', 'utf8');

    const store = new SnapshotStore({ cwd: workspace, homeDir: home });
    const hash = await store.create();
    expect(hash).toBeTruthy();

    // Create an ignored artefact after the snapshot.
    await Bun.write(join(workspace, 'ignored', 'big.bin'), 'artifact');
    const restored = await store.restore(hash as string);
    expect(restored.ok).toBe(true);
    expect(existsSync(join(workspace, 'ignored', 'big.bin'))).toBe(true);
  });

  test('create() returns undefined gracefully when git fails', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-snap-ws-'));
    home = await mkdtemp(join(tmpdir(), 'juno-snap-home-'));
    const store = new SnapshotStore({
      cwd: workspace,
      homeDir: home,
      deps: {
        runGit: async (args) =>
          args.includes('init')
            ? { code: 0, stdout: '', stderr: '' }
            : { code: 128, stdout: '', stderr: 'boom' },
      },
    });
    expect(await store.create()).toBeUndefined();
  });
});
