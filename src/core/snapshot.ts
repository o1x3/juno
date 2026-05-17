// Per-turn filesystem snapshots backed by a shadow git directory.
//
// The shadow repo lives under `$JUNO_HOME/snapshots/<hash(cwd)>` and points its
// `--work-tree` at the user's workspace. It never touches the user's real
// `.git` — no stashes, no commits, no index churn in their history. Each
// mutating turn writes a tree+commit; `/undo` reads that tree back and cleans
// anything created since. Adapted from opencode's snapshot module, reduced to
// plain async Bun (no Effect, no separate gc daemon — a bounded prune on init).

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { findGitRoot } from '@/core/instructions';

const SNAPSHOT_AUTHOR = [
  '-c',
  'user.name=juno-snapshot',
  '-c',
  'user.email=snapshot@juno.local',
];

// Keep snapshots from leaking CRLF / symlink / longpath surprises across the
// shadow boundary; mirrors opencode's core git config.
const CORE_FLAGS = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.symlinks=true',
];

export type GitRun = {
  code: number;
  stdout: string;
  stderr: string;
};

export type SnapshotDeps = {
  // Injectable for tests; defaults to spawning the real `git`.
  runGit?: (args: string[], cwd: string) => Promise<GitRun>;
};

async function defaultRunGit(args: string[], cwd: string): Promise<GitRun> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (error) {
    return {
      code: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function shadowDirFor(homeDir: string, cwd: string): string {
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return join(homeDir, 'snapshots', hash);
}

export class SnapshotStore {
  private readonly cwd: string;
  private readonly gitDir: string;
  private readonly runGit: (args: string[], cwd: string) => Promise<GitRun>;
  private initialized = false;

  constructor(opts: {
    cwd: string;
    homeDir: string;
    deps?: SnapshotDeps;
  }) {
    this.cwd = opts.cwd;
    this.gitDir = shadowDirFor(opts.homeDir, opts.cwd);
    this.runGit = opts.deps?.runGit ?? defaultRunGit;
  }

  private base(extra: string[]): string[] {
    return [
      ...CORE_FLAGS,
      '--git-dir',
      this.gitDir,
      '--work-tree',
      this.cwd,
      ...extra,
    ];
  }

  private git(extra: string[]): Promise<GitRun> {
    return this.runGit(this.base(extra), this.cwd);
  }

  /** True only when the workspace is inside a real git repo. */
  static async enabled(cwd: string): Promise<boolean> {
    try {
      const root = await findGitRoot(cwd);
      return existsSync(join(root, '.git'));
    } catch {
      return false;
    }
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    try {
      await mkdir(this.gitDir, { recursive: true });
    } catch {
      return false;
    }
    if (!existsSync(join(this.gitDir, 'HEAD'))) {
      const res = await this.runGit(
        ['--git-dir', this.gitDir, 'init', '--quiet'],
        this.cwd,
      );
      if (res.code !== 0) return false;
      for (const [k, v] of [
        ['core.autocrlf', 'false'],
        ['core.longpaths', 'true'],
        ['core.symlinks', 'true'],
        ['core.fsmonitor', 'false'],
        ['gc.auto', '0'],
      ] as const) {
        await this.runGit(['--git-dir', this.gitDir, 'config', k, v], this.cwd);
      }
    }
    this.initialized = true;
    return true;
  }

  /**
   * Stage the whole worktree (respecting the user's .gitignore) and write a
   * reachable commit. Returns the commit sha, or undefined if anything failed
   * — snapshots are best-effort and must never break a turn.
   */
  async create(): Promise<string | undefined> {
    if (!(await this.init())) return undefined;
    const add = await this.git(['add', '-A']);
    if (add.code !== 0) return undefined;
    const tree = await this.git(['write-tree']);
    if (tree.code !== 0) return undefined;
    const treeSha = tree.stdout.trim();
    if (!treeSha) return undefined;
    const commit = await this.runGit(
      [
        ...CORE_FLAGS,
        '--git-dir',
        this.gitDir,
        '--work-tree',
        this.cwd,
        ...SNAPSHOT_AUTHOR,
        'commit-tree',
        treeSha,
        '-m',
        'juno snapshot',
      ],
      this.cwd,
    );
    if (commit.code !== 0) return undefined;
    const sha = commit.stdout.trim();
    return sha.length > 0 ? sha : undefined;
  }

  /**
   * Restore the workspace to a snapshot: write the snapshot tree to the index,
   * force every tracked file back to disk, then remove anything created since
   * (git clean, without -x so gitignored paths like node_modules are safe).
   */
  async restore(hash: string): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.init()))
      return { ok: false, error: 'snapshot init failed' };
    const read = await this.git(['read-tree', hash]);
    if (read.code !== 0) return { ok: false, error: read.stderr.trim() };
    const checkout = await this.git(['checkout-index', '-a', '-f']);
    if (checkout.code !== 0)
      return { ok: false, error: checkout.stderr.trim() };
    // -d directories, -f force, no -x so ignored files (node_modules, dist…)
    // are never deleted.
    const clean = await this.git(['clean', '-d', '-f']);
    if (clean.code !== 0) return { ok: false, error: clean.stderr.trim() };
    return { ok: true };
  }

  /** Unified diff of the working tree against a snapshot, for display. */
  async diff(hash: string): Promise<string> {
    if (!(await this.init())) return '';
    await this.git(['add', '-A']);
    const res = await this.git([
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-color',
      hash,
    ]);
    return res.code === 0 ? res.stdout.trim() : '';
  }
}
