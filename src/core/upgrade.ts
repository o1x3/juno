import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const RELEASES_REPO = 'o1x3/juno';
export const VERSION_CACHE_TTL_MS = 20 * 60 * 60 * 1000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type ReleaseTarget = {
  os: 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
};

export type ReleaseAssets = {
  tag: string;
  version: string;
  filename: string;
  tarballUrl: string;
  checksumsUrl: string;
};

export type VersionCache = {
  latest_version: string;
  last_checked_at: string;
  dismissed_version?: string;
};

export type InstallContext =
  | { kind: 'standalone'; execPath: string; writable: boolean }
  | { kind: 'homebrew'; execPath: string; command: string }
  | { kind: 'npm'; execPath: string; command: string }
  | { kind: 'unknown'; execPath: string };

export function stripV(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version;
}

export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const m = stripV(version).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  return {
    major: Number.parseInt(m[1], 10),
    minor: Number.parseInt(m[2], 10),
    patch: Number.parseInt(m[3], 10),
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

export function detectTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ReleaseTarget | undefined {
  let os: 'darwin' | 'linux';
  if (platform === 'darwin') os = 'darwin';
  else if (platform === 'linux') os = 'linux';
  else return undefined;
  let a: 'x64' | 'arm64';
  if (arch === 'x64') a = 'x64';
  else if (arch === 'arm64') a = 'arm64';
  else return undefined;
  return { os, arch: a };
}

export function buildReleaseAssets(
  tag: string,
  target: ReleaseTarget,
  repo: string = RELEASES_REPO,
): ReleaseAssets {
  const version = stripV(tag);
  const filename = `juno-${version}-${target.os}-${target.arch}.tar.gz`;
  return {
    tag,
    version,
    filename,
    tarballUrl: `https://github.com/${repo}/releases/download/${tag}/${filename}`,
    checksumsUrl: `https://github.com/${repo}/releases/download/${tag}/checksums.txt`,
  };
}

export async function fetchLatestTag(options: {
  repo?: string;
  fetcher?: Fetcher;
}): Promise<string> {
  const repo = options.repo ?? RELEASES_REPO;
  const f = options.fetcher ?? fetch;
  const response = await f(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: { Accept: 'application/vnd.github+json' },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub releases API returned ${response.status}`);
  }
  const data = (await response.json()) as { tag_name?: string };
  if (!data.tag_name) {
    throw new Error('GitHub releases response missing tag_name');
  }
  return data.tag_name;
}

export function readVersionCache(cachePath: string): VersionCache | undefined {
  if (!existsSync(cachePath)) return undefined;
  try {
    const content = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<VersionCache>;
    if (
      typeof parsed.latest_version === 'string' &&
      typeof parsed.last_checked_at === 'string'
    ) {
      return {
        latest_version: parsed.latest_version,
        last_checked_at: parsed.last_checked_at,
        dismissed_version: parsed.dismissed_version,
      };
    }
  } catch {
    // fall through
  }
  return undefined;
}

export async function writeVersionCache(
  cachePath: string,
  info: VersionCache,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(info)}\n`);
}

export function isCacheFresh(
  cache: VersionCache | undefined,
  ttlMs: number = VERSION_CACHE_TTL_MS,
  now: Date = new Date(),
): boolean {
  if (!cache) return false;
  const checked = Date.parse(cache.last_checked_at);
  if (Number.isNaN(checked)) return false;
  return now.getTime() - checked < ttlMs;
}

export type CheckForUpdateResult = {
  current: string;
  latest: string;
  hasUpdate: boolean;
  dismissed: boolean;
  fromCache: boolean;
};

export async function checkForUpdate(options: {
  current: string;
  cachePath: string;
  repo?: string;
  ttlMs?: number;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<CheckForUpdateResult> {
  const ttl = options.ttlMs ?? VERSION_CACHE_TTL_MS;
  const now = options.now ?? new Date();
  const cache = readVersionCache(options.cachePath);
  let latest: string;
  let fromCache = false;
  let dismissed: string | undefined;

  if (cache && isCacheFresh(cache, ttl, now)) {
    latest = cache.latest_version;
    dismissed = cache.dismissed_version;
    fromCache = true;
  } else {
    const tag = await fetchLatestTag({
      repo: options.repo,
      fetcher: options.fetcher,
    });
    latest = stripV(tag);
    dismissed = cache?.dismissed_version;
    await writeVersionCache(options.cachePath, {
      latest_version: latest,
      last_checked_at: now.toISOString(),
      dismissed_version: dismissed,
    });
  }

  return {
    current: stripV(options.current),
    latest,
    hasUpdate: isNewer(latest, options.current),
    dismissed: dismissed === latest,
    fromCache,
  };
}

export async function dismissVersion(
  cachePath: string,
  version: string,
): Promise<void> {
  const cache = readVersionCache(cachePath);
  if (!cache) return;
  await writeVersionCache(cachePath, {
    ...cache,
    dismissed_version: version,
  });
}

export function detectInstallContext(
  execPath: string = process.execPath,
): InstallContext {
  const lower = execPath.toLowerCase();
  if (
    lower.includes('/homebrew/') ||
    lower.includes('/cellar/') ||
    lower.startsWith('/opt/homebrew/')
  ) {
    return {
      kind: 'homebrew',
      execPath,
      command: 'brew upgrade juno',
    };
  }
  if (lower.includes('/node_modules/')) {
    return {
      kind: 'npm',
      execPath,
      command: 'npm install -g juno@latest',
    };
  }
  // Standalone: check whether the file is writable by the running process.
  let writable = false;
  try {
    statSync(execPath);
    accessSync(execPath, fsConstants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { kind: 'standalone', execPath, writable };
}

function sha256(buffer: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(buffer);
  return hash.digest('hex');
}

export async function downloadAndVerify(options: {
  assets: ReleaseAssets;
  fetcher?: Fetcher;
}): Promise<{ binaryPath: string; sha256: string; cleanup: () => void }> {
  const f = options.fetcher ?? fetch;
  const stage = mkdtempSync(join(tmpdir(), 'juno-upgrade-'));
  const cleanup = () => {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    const tarballResponse = await f(options.assets.tarballUrl);
    if (!tarballResponse.ok) {
      throw new Error(
        `Failed to download ${options.assets.filename}: HTTP ${tarballResponse.status}`,
      );
    }
    const tarballBytes = new Uint8Array(await tarballResponse.arrayBuffer());
    const tarballPath = join(stage, options.assets.filename);
    writeFileSync(tarballPath, tarballBytes);
    const actual = sha256(tarballBytes);

    const checksumsResponse = await f(options.assets.checksumsUrl);
    if (!checksumsResponse.ok) {
      throw new Error(
        `Failed to fetch checksums.txt: HTTP ${checksumsResponse.status}`,
      );
    }
    const checksumsText = await checksumsResponse.text();
    const expected = findChecksum(checksumsText, options.assets.filename);
    if (!expected) {
      throw new Error(
        `checksums.txt is missing an entry for ${options.assets.filename}`,
      );
    }
    if (expected !== actual) {
      throw new Error(
        `Checksum mismatch for ${options.assets.filename}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      );
    }

    const extractResult = Bun.spawnSync({
      cmd: ['tar', '-xzf', tarballPath, '-C', stage],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (extractResult.exitCode !== 0) {
      const err = new TextDecoder().decode(extractResult.stderr);
      throw new Error(`Failed to extract ${options.assets.filename}: ${err}`);
    }
    const binaryPath = join(stage, 'juno');
    if (!existsSync(binaryPath)) {
      throw new Error(
        `Archive ${options.assets.filename} did not contain a juno binary`,
      );
    }
    chmodSync(binaryPath, 0o755);
    return { binaryPath, sha256: actual, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function findChecksum(
  checksumsText: string,
  filename: string,
): string | undefined {
  for (const line of checksumsText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed?.includes(filename)) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[parts.length - 1]?.endsWith(filename)) {
      return parts[0];
    }
  }
  return undefined;
}

export type ReplaceResult = {
  swappedFrom: string;
  swappedTo: string;
  backupPath: string;
};

export function replaceBinary(options: {
  srcBinary: string;
  destPath: string;
}): ReplaceResult {
  const backupPath = `${options.destPath}.old`;
  // Remove any existing .old (single-generation backup)
  if (existsSync(backupPath)) {
    rmSync(backupPath, { force: true });
  }
  if (existsSync(options.destPath)) {
    renameSync(options.destPath, backupPath);
  }
  try {
    renameSync(options.srcBinary, options.destPath);
  } catch {
    // Cross-device fallback (e.g. /tmp on a different fs than the install dir)
    copyFileSync(options.srcBinary, options.destPath);
    rmSync(options.srcBinary, { force: true });
  }
  chmodSync(options.destPath, 0o755);
  return {
    swappedFrom: options.destPath,
    swappedTo: options.destPath,
    backupPath,
  };
}

export function rollbackBinary(execPath: string): { restored: string } {
  const backupPath = `${execPath}.old`;
  if (!existsSync(backupPath)) {
    throw new Error(`No backup found at ${backupPath}`);
  }
  const tempPath = `${execPath}.swap`;
  if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  if (existsSync(execPath)) {
    renameSync(execPath, tempPath);
  }
  renameSync(backupPath, execPath);
  if (existsSync(tempPath)) {
    renameSync(tempPath, backupPath);
  }
  chmodSync(execPath, 0o755);
  return { restored: execPath };
}

export type UpgradeOutcome =
  | { status: 'up-to-date'; current: string; latest: string }
  | {
      status: 'upgraded';
      from: string;
      to: string;
      execPath: string;
      backupPath: string;
    }
  | { status: 'managed'; context: InstallContext; latest?: string }
  | { status: 'not-writable'; execPath: string; latest?: string };

export async function performUpgrade(options: {
  current: string;
  targetTag?: string;
  execPath?: string;
  repo?: string;
  fetcher?: Fetcher;
  cachePath?: string;
}): Promise<UpgradeOutcome> {
  const execPath = options.execPath ?? process.execPath;
  const ctx = detectInstallContext(execPath);
  const target = detectTarget();
  if (!target) {
    throw new Error(
      `Unsupported platform: ${process.platform}/${process.arch}`,
    );
  }
  if (ctx.kind === 'homebrew' || ctx.kind === 'npm') {
    return { status: 'managed', context: ctx };
  }

  let targetTag: string;
  if (options.targetTag) {
    targetTag = options.targetTag.startsWith('v')
      ? options.targetTag
      : `v${options.targetTag}`;
  } else {
    targetTag = await fetchLatestTag({
      repo: options.repo,
      fetcher: options.fetcher,
    });
  }
  const targetVersion = stripV(targetTag);

  if (!isNewer(targetVersion, options.current)) {
    return {
      status: 'up-to-date',
      current: stripV(options.current),
      latest: targetVersion,
    };
  }

  if (ctx.kind === 'standalone' && !ctx.writable) {
    return { status: 'not-writable', execPath, latest: targetVersion };
  }

  const assets = buildReleaseAssets(targetTag, target, options.repo);
  const downloaded = await downloadAndVerify({
    assets,
    fetcher: options.fetcher,
  });
  try {
    const replaced = replaceBinary({
      srcBinary: downloaded.binaryPath,
      destPath: execPath,
    });
    if (options.cachePath) {
      await writeVersionCache(options.cachePath, {
        latest_version: targetVersion,
        last_checked_at: new Date().toISOString(),
      });
    }
    return {
      status: 'upgraded',
      from: stripV(options.current),
      to: targetVersion,
      execPath,
      backupPath: replaced.backupPath,
    };
  } finally {
    downloaded.cleanup();
  }
}
