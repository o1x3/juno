import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configFileSchema, resolveConfig, saveConfig } from '@/core/config';

let workspace = '';
let prevConfig: string | undefined;
let prevHome: string | undefined;

beforeEach(async () => {
  prevConfig = process.env.JUNO_CONFIG;
  prevHome = process.env.JUNO_HOME;
  workspace = await mkdtemp(join(tmpdir(), 'juno-cfgsave-'));
  process.env.JUNO_HOME = workspace;
  process.env.JUNO_CONFIG = join(workspace, 'config.json');
});

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = '';
  if (prevConfig === undefined) delete process.env.JUNO_CONFIG;
  else process.env.JUNO_CONFIG = prevConfig;
  if (prevHome === undefined) delete process.env.JUNO_HOME;
  else process.env.JUNO_HOME = prevHome;
});

describe('saveConfig', () => {
  test('writes a fresh config file', async () => {
    const path = join(workspace, 'config.json');
    await saveConfig(path, { execModel: 'gpt-5.4-mini', planModel: 'gpt-5.4' });
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.execModel).toBe('gpt-5.4-mini');
    expect(parsed.planModel).toBe('gpt-5.4');
  });

  test('merges into existing config preserving unrelated keys', async () => {
    const path = join(workspace, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ model: 'gpt-5.4', maxSteps: 16 }, null, 2),
    );
    await saveConfig(path, { execModel: 'gpt-5.4-mini' });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.model).toBe('gpt-5.4');
    expect(parsed.maxSteps).toBe(16);
    expect(parsed.execModel).toBe('gpt-5.4-mini');
  });

  test('rejects unknown keys via strict schema', async () => {
    const path = join(workspace, 'config.json');
    expect(() =>
      saveConfig(path, { bogusKey: true } as unknown as Parameters<
        typeof saveConfig
      >[1]),
    ).toThrow();
  });

  test('round-trips ui block', async () => {
    const path = join(workspace, 'config.json');
    await saveConfig(path, {
      ui: { statusPane: 'hidden', theme: 'dark', timestamps: true },
    });
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    expect(parsed.ui).toMatchObject({
      statusPane: 'hidden',
      theme: 'dark',
      timestamps: true,
    });
  });

  test('resolveConfig picks up the saved values', async () => {
    const path = join(workspace, 'config.json');
    await saveConfig(path, {
      execModel: 'saved-exec',
      planModel: 'saved-plan',
    });
    const resolved = resolveConfig({ cwd: workspace });
    expect(resolved.execModel).toBe('saved-exec');
    expect(resolved.planModel).toBe('saved-plan');
  });
});

describe('configFileSchema', () => {
  test('accepts the new keys', () => {
    expect(() =>
      configFileSchema.parse({
        execModel: 'a',
        planModel: 'b',
        namingModel: 'c',
        autoName: true,
        ui: { statusPane: 'visible', theme: 'auto', timestamps: false },
      }),
    ).not.toThrow();
  });

  test('rejects unknown ui keys', () => {
    expect(() => configFileSchema.parse({ ui: { wat: true } })).toThrow();
  });
});
