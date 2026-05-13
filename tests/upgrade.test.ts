import { beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildReleaseAssets,
  checkForUpdate,
  compareVersions,
  detectInstallContext,
  detectTarget,
  dismissVersion,
  type Fetcher,
  findChecksum,
  isCacheFresh,
  isNewer,
  parseSemver,
  performUpgrade,
  readVersionCache,
  replaceBinary,
  rollbackBinary,
  stripV,
  writeVersionCache,
} from '@/core/upgrade';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'juno-upgrade-'));
});

describe('semver helpers', () => {
  test('stripV', () => {
    expect(stripV('v1.2.3')).toBe('1.2.3');
    expect(stripV('1.2.3')).toBe('1.2.3');
  });
  test('parseSemver', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('garbage')).toBeUndefined();
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3 });
  });
  test('compareVersions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('v2.0.0', 'v1.99.99')).toBe(1);
  });
  test('isNewer', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.0.0', '1.2.3')).toBe(false);
  });
});

describe('detectTarget', () => {
  test('darwin arm64', () => {
    expect(detectTarget('darwin', 'arm64')).toEqual({
      os: 'darwin',
      arch: 'arm64',
    });
  });
  test('linux x64', () => {
    expect(detectTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
  });
  test('windows is unsupported', () => {
    expect(detectTarget('win32', 'x64')).toBeUndefined();
  });
});

describe('buildReleaseAssets', () => {
  test('builds tarball + checksums url', () => {
    const assets = buildReleaseAssets(
      'v0.2.0',
      { os: 'darwin', arch: 'arm64' },
      'o1x3/juno',
    );
    expect(assets.version).toBe('0.2.0');
    expect(assets.filename).toBe('juno-0.2.0-darwin-arm64.tar.gz');
    expect(assets.tarballUrl).toBe(
      'https://github.com/o1x3/juno/releases/download/v0.2.0/juno-0.2.0-darwin-arm64.tar.gz',
    );
    expect(assets.checksumsUrl).toBe(
      'https://github.com/o1x3/juno/releases/download/v0.2.0/checksums.txt',
    );
  });
});

describe('findChecksum', () => {
  test('matches the right line', () => {
    const text = [
      'abc123  juno-0.2.0-linux-x64.tar.gz',
      'def456  juno-0.2.0-darwin-arm64.tar.gz',
      'ghi789  juno-0.2.0-linux-arm64.tar.gz',
    ].join('\n');
    expect(findChecksum(text, 'juno-0.2.0-darwin-arm64.tar.gz')).toBe('def456');
    expect(findChecksum(text, 'juno-99.tar.gz')).toBeUndefined();
  });
});

describe('version cache', () => {
  test('round trip', async () => {
    const cachePath = join(workspace, 'version.json');
    await writeVersionCache(cachePath, {
      latest_version: '0.3.0',
      last_checked_at: '2026-05-14T00:00:00.000Z',
    });
    const cache = readVersionCache(cachePath);
    expect(cache?.latest_version).toBe('0.3.0');
  });
  test('missing file returns undefined', () => {
    expect(readVersionCache(join(workspace, 'missing.json'))).toBeUndefined();
  });
  test('garbage file returns undefined', () => {
    const p = join(workspace, 'bad.json');
    writeFileSync(p, '{not json');
    expect(readVersionCache(p)).toBeUndefined();
  });
  test('isCacheFresh', () => {
    const now = new Date('2026-05-14T12:00:00Z');
    expect(
      isCacheFresh(
        {
          latest_version: '0.3.0',
          last_checked_at: '2026-05-14T00:00:00Z',
        },
        20 * 60 * 60 * 1000,
        now,
      ),
    ).toBe(true);
    expect(
      isCacheFresh(
        {
          latest_version: '0.3.0',
          last_checked_at: '2026-05-10T00:00:00Z',
        },
        20 * 60 * 60 * 1000,
        now,
      ),
    ).toBe(false);
  });
  test('dismissVersion preserves the latest entry', async () => {
    const cachePath = join(workspace, 'version.json');
    await writeVersionCache(cachePath, {
      latest_version: '0.3.0',
      last_checked_at: '2026-05-14T00:00:00.000Z',
    });
    await dismissVersion(cachePath, '0.3.0');
    const cache = readVersionCache(cachePath);
    expect(cache?.dismissed_version).toBe('0.3.0');
    expect(cache?.latest_version).toBe('0.3.0');
  });
});

describe('checkForUpdate', () => {
  test('uses cached value when fresh', async () => {
    const cachePath = join(workspace, 'version.json');
    await writeVersionCache(cachePath, {
      latest_version: '0.3.0',
      last_checked_at: new Date().toISOString(),
    });
    const fetcher: Fetcher = async () => {
      throw new Error('should not be called');
    };
    const result = await checkForUpdate({
      current: '0.1.0',
      cachePath,
      fetcher,
    });
    expect(result.latest).toBe('0.3.0');
    expect(result.hasUpdate).toBe(true);
    expect(result.fromCache).toBe(true);
  });

  test('refreshes cache when stale', async () => {
    const cachePath = join(workspace, 'version.json');
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ tag_name: 'v0.4.0' }), {
        status: 200,
      });
    const result = await checkForUpdate({
      current: '0.1.0',
      cachePath,
      fetcher,
    });
    expect(result.latest).toBe('0.4.0');
    expect(result.fromCache).toBe(false);
    const written = readVersionCache(cachePath);
    expect(written?.latest_version).toBe('0.4.0');
  });

  test('dismissed surfaces in result', async () => {
    const cachePath = join(workspace, 'version.json');
    await writeVersionCache(cachePath, {
      latest_version: '0.3.0',
      last_checked_at: new Date().toISOString(),
      dismissed_version: '0.3.0',
    });
    const result = await checkForUpdate({
      current: '0.1.0',
      cachePath,
    });
    expect(result.dismissed).toBe(true);
  });
});

describe('detectInstallContext', () => {
  test('homebrew', () => {
    const ctx = detectInstallContext('/opt/homebrew/bin/juno');
    expect(ctx.kind).toBe('homebrew');
  });
  test('cellar (intel mac)', () => {
    const ctx = detectInstallContext('/usr/local/Cellar/juno/0.2.0/bin/juno');
    expect(ctx.kind).toBe('homebrew');
  });
  test('npm', () => {
    const ctx = detectInstallContext('/Users/x/node_modules/juno/bin/juno');
    expect(ctx.kind).toBe('npm');
  });
  test('standalone writable', () => {
    const binary = join(workspace, 'juno');
    writeFileSync(binary, '#!/bin/sh\necho test\n');
    chmodSync(binary, 0o755);
    const ctx = detectInstallContext(binary);
    expect(ctx.kind).toBe('standalone');
    if (ctx.kind === 'standalone') {
      expect(ctx.writable).toBe(true);
    }
  });
  test('standalone missing file is not-writable', () => {
    const ctx = detectInstallContext(join(workspace, 'never-existed'));
    expect(ctx.kind).toBe('standalone');
    if (ctx.kind === 'standalone') expect(ctx.writable).toBe(false);
  });
});

describe('replaceBinary + rollback', () => {
  test('keeps a .old backup and restores it', () => {
    const dest = join(workspace, 'juno');
    writeFileSync(dest, 'old');
    chmodSync(dest, 0o755);
    const src = join(workspace, 'juno.new-src');
    writeFileSync(src, 'new');
    chmodSync(src, 0o755);
    const result = replaceBinary({ srcBinary: src, destPath: dest });
    expect(readFileSync(dest, 'utf8')).toBe('new');
    expect(readFileSync(result.backupPath, 'utf8')).toBe('old');

    const restore = rollbackBinary(dest);
    expect(readFileSync(restore.restored, 'utf8')).toBe('old');
    // .old should now contain the previously-live "new" content
    expect(readFileSync(`${dest}.old`, 'utf8')).toBe('new');
  });
});

describe('performUpgrade', () => {
  test('up-to-date when current matches latest', async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ tag_name: 'v0.2.0' }));
    const outcome = await performUpgrade({
      current: '0.2.0',
      execPath: join(workspace, 'juno'),
      fetcher,
    });
    expect(outcome.status).toBe('up-to-date');
  });

  test('returns managed for homebrew installs', async () => {
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9' }));
    const outcome = await performUpgrade({
      current: '0.1.0',
      execPath: '/opt/homebrew/bin/juno',
      fetcher,
    });
    expect(outcome.status).toBe('managed');
  });

  test('returns not-writable for read-only install path', async () => {
    const fakeBin = join(workspace, 'readonly', 'juno');
    mkdirSync(join(workspace, 'readonly'), { recursive: true });
    writeFileSync(fakeBin, 'x');
    chmodSync(fakeBin, 0o555);
    try {
      chmodSync(join(workspace, 'readonly'), 0o555);
    } catch {
      /* ignore on filesystems that don't honor chmod */
    }
    const fetcher: Fetcher = async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9' }));
    const outcome = await performUpgrade({
      current: '0.1.0',
      execPath: fakeBin,
      fetcher,
    });
    // restore perms so afterEach cleanup works
    try {
      chmodSync(join(workspace, 'readonly'), 0o755);
    } catch {
      /* ignore */
    }
    expect(outcome.status).toBe('not-writable');
  });
});
