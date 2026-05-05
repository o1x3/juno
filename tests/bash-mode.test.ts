import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeShellCommand } from '@/core/tools';

describe('executeShellCommand', () => {
  test('runs a command and captures stdout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'juno-shell-'));
    try {
      const result = await executeShellCommand("echo 'hello world'", { cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.timedOut).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('captures non-zero exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'juno-shell-'));
    try {
      const result = await executeShellCommand('exit 7', { cwd });
      expect(result.exitCode).toBe(7);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('respects timeoutMs when provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'juno-shell-'));
    try {
      const result = await executeShellCommand('sleep 5', {
        cwd,
        timeoutMs: 100,
      });
      expect(result.timedOut).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('without timeoutMs, long sleep is not killed prematurely', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'juno-shell-'));
    try {
      // Use a shorter sleep to keep the test fast but still validate no kill.
      const start = Date.now();
      const result = await executeShellCommand('sleep 0.3', { cwd });
      const elapsed = Date.now() - start;
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(300);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('outputLimit truncates very long output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'juno-shell-'));
    try {
      const result = await executeShellCommand('printf "%010000d" 0', {
        cwd,
        outputLimit: 100,
      });
      expect(result.stdout.length).toBeLessThan(10_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
