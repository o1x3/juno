import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { VERSION } from '@/version';
import pkg from '../package.json' with { type: 'json' };

const SCRIPT_PATH = join(import.meta.dir, '..', 'src', 'cli', 'index.tsx');

// `bun test` sets NODE_ENV=test in the parent. Spawn the child with
// NODE_ENV unset so the assertions reflect real-user behavior in CI
// (non-TTY stdout) and locally.
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'NODE_ENV') {
      env[key] = value;
    }
  }
  return env;
}

describe('juno --version', () => {
  test('exported VERSION matches package.json in dev', () => {
    expect(VERSION).toBe(pkg.version);
  });

  test('CLI prints the bare version and exits 0', () => {
    const cli = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT_PATH, '--version'],
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect({
      exit: cli.exitCode,
      stdout: cli.stdout.toString(),
      stderr: cli.stderr.toString().trim(),
    }).toEqual({
      exit: 0,
      stdout: `${pkg.version}\n`,
      stderr: '',
    });
  });

  test('-v alias also prints the bare version', () => {
    const cli = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT_PATH, '-v'],
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(cli.exitCode).toBe(0);
    expect(cli.stdout.toString()).toBe(`${pkg.version}\n`);
  });

  test('CLI --help still works after --version wiring', () => {
    const cli = Bun.spawnSync({
      cmd: [process.execPath, SCRIPT_PATH, '--help'],
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = cli.stdout.toString();

    expect(cli.exitCode).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('juno');
  });
});
