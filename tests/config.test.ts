import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig } from '@/core/config';

const ENV_KEYS = [
  'JUNO_HOME',
  'JUNO_CONFIG',
  'JUNO_MODEL',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'JUNO_MAX_STEPS',
  'JUNO_TOOL_OUTPUT_LIMIT',
  'JUNO_READ_LINE_LIMIT',
  'JUNO_BASH_TIMEOUT_MS',
  'OPENAI_API_KEY',
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

let workspace = '';

async function writeConfigFile(
  homeDir: string,
  contents: string,
  fileName = 'config.json',
): Promise<string> {
  const path = join(homeDir, fileName);
  await writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

describe('resolveConfig', () => {
  test('missing config file uses defaults', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    delete process.env.JUNO_CONFIG;

    const config = resolveConfig({ cwd: workspace });

    expect(config.homeDir).toBe(workspace);
    expect(config.model).toBe('gpt-5.4-mini');
    expect(config.baseUrl).toBeUndefined();
    expect(config.maxSteps).toBe(12);
    expect(config.toolOutputLimit).toBe(12000);
    expect(config.readLineLimit).toBe(400);
    expect(config.bashTimeoutMs).toBe(15000);
  });

  test('valid config file is applied', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    await writeConfigFile(
      workspace,
      JSON.stringify({
        model: 'gpt-5.4',
        baseUrl: 'https://example.test/v1',
        maxSteps: 22,
        toolOutputLimit: 9000,
        readLineLimit: 123,
        bashTimeoutMs: 4567,
      }),
    );

    const config = resolveConfig({ cwd: workspace });

    expect(config.model).toBe('gpt-5.4');
    expect(config.baseUrl).toBe('https://example.test/v1');
    expect(config.maxSteps).toBe(22);
    expect(config.toolOutputLimit).toBe(9000);
    expect(config.readLineLimit).toBe(123);
    expect(config.bashTimeoutMs).toBe(4567);
  });

  test('env overrides config', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    await writeConfigFile(
      workspace,
      JSON.stringify({
        model: 'gpt-5.4',
        baseUrl: 'https://config.example/v1',
        maxSteps: 10,
        toolOutputLimit: 4000,
        readLineLimit: 111,
        bashTimeoutMs: 5000,
      }),
    );
    process.env.JUNO_MODEL = 'gpt-5.4-mini';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.JUNO_MAX_STEPS = '17';
    process.env.JUNO_TOOL_OUTPUT_LIMIT = '7000';
    process.env.JUNO_READ_LINE_LIMIT = '222';
    process.env.JUNO_BASH_TIMEOUT_MS = '6000';

    const config = resolveConfig({ cwd: workspace });

    expect(config.model).toBe('gpt-5.4-mini');
    expect(config.baseUrl).toBe('https://env.example/v1');
    expect(config.maxSteps).toBe(17);
    expect(config.toolOutputLimit).toBe(7000);
    expect(config.readLineLimit).toBe(222);
    expect(config.bashTimeoutMs).toBe(6000);
  });

  test('invalid numeric env values fail instead of coercing or falling back', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    await writeConfigFile(
      workspace,
      JSON.stringify({
        maxSteps: 10,
      }),
    );

    process.env.JUNO_MAX_STEPS = '1.5';
    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      'Invalid environment variable JUNO_MAX_STEPS: expected a positive integer',
    );

    process.env.JUNO_MAX_STEPS = '12abc';
    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      'Invalid environment variable JUNO_MAX_STEPS: expected a positive integer',
    );

    process.env.JUNO_MAX_STEPS = '0';
    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      'Invalid environment variable JUNO_MAX_STEPS: expected a positive integer',
    );

    process.env.JUNO_MAX_STEPS = 'abc';
    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      'Invalid environment variable JUNO_MAX_STEPS: expected a positive integer',
    );
  });

  test('cli overrides env and config', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    await writeConfigFile(
      workspace,
      JSON.stringify({
        model: 'gpt-5.4',
        baseUrl: 'https://config.example/v1',
        maxSteps: 10,
      }),
    );
    process.env.JUNO_MODEL = 'gpt-5.4-mini';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.JUNO_MAX_STEPS = '17';

    const config = resolveConfig({
      cwd: workspace,
      model: 'gpt-5',
      baseUrl: 'https://cli.example/v1',
      maxSteps: 33,
    });

    expect(config.model).toBe('gpt-5');
    expect(config.baseUrl).toBe('https://cli.example/v1');
    expect(config.maxSteps).toBe(33);
  });

  test('malformed JSON fails with clear error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    const configPath = await writeConfigFile(workspace, '{"model":');

    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      `Invalid config at ${configPath}:`,
    );
  });

  test('unknown key fails', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    const configPath = await writeConfigFile(
      workspace,
      JSON.stringify({
        model: 'gpt-5.4',
        apiKey: 'should-not-be-here',
      }),
    );

    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      `Invalid config at ${configPath}:`,
    );
  });

  test('invalid numeric and string values fail', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    const configPath = await writeConfigFile(
      workspace,
      JSON.stringify({
        model: '   ',
        maxSteps: 0,
      }),
      'invalid-values.json',
    );
    process.env.JUNO_CONFIG = configPath;

    expect(() => resolveConfig({ cwd: workspace })).toThrow(
      `Invalid config at ${configPath}:`,
    );
  });

  test('config does not affect credential sourcing', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    process.env.JUNO_HOME = workspace;
    process.env.OPENAI_API_KEY = 'env-key';
    await writeConfigFile(
      workspace,
      JSON.stringify({
        model: 'gpt-5.4',
      }),
    );

    const config = resolveConfig({ cwd: workspace });

    expect(config.apiKey).toBe('env-key');
    expect(config.authFile).toBe(join(workspace, 'auth.json'));
  });

  test('cli prints a concise config error without a stack trace', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-config-'));
    const configPath = await writeConfigFile(workspace, '{"model":');

    const cli = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli/index.tsx', 'sessions'],
      cwd: '/Users/karthikvinayan/code/work/juno/nexus',
      env: {
        ...process.env,
        JUNO_HOME: workspace,
        JUNO_CONFIG: configPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stderr = cli.stderr.toString().trim();

    expect(cli.exitCode).toBe(1);
    expect(stderr).toContain(`Invalid config at ${configPath}:`);
    expect(stderr).not.toContain('at loadConfigFile');
    expect(stderr).not.toContain('at resolveConfig');
  });
});
