import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { AgentConfig } from '@/types';

const DEFAULT_HOME_DIR = join(homedir(), '.juno');
const DEFAULT_CONFIG_FILE = 'config.json';

const configFileSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    maxSteps: z.number().int().positive().finite().optional(),
    toolOutputLimit: z.number().int().positive().finite().optional(),
    readLineLimit: z.number().int().positive().finite().optional(),
    bashTimeoutMs: z.number().int().positive().finite().optional(),
  })
  .strict();

type ConfigFile = z.infer<typeof configFileSchema>;

export type ConfigOverrides = {
  cwd?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxSteps?: number;
};

function loadConfigFile(configFile: string): ConfigFile {
  if (!existsSync(configFile)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid config at ${configFile}: ${reason}`);
  }

  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const issuePath = issue?.path.length ? issue.path.join('.') : 'root';
    throw new Error(
      `Invalid config at ${configFile}: ${issuePath} ${issue?.message}`,
    );
  }

  return result.data;
}

function parsePositiveIntEnv(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `Invalid environment variable ${name}: expected a positive integer`,
    );
  }

  return Number.parseInt(value, 10);
}

export function resolveConfig(overrides: ConfigOverrides = {}): AgentConfig {
  const homeDir = process.env.JUNO_HOME ?? DEFAULT_HOME_DIR;
  const configFile =
    process.env.JUNO_CONFIG ?? join(homeDir, DEFAULT_CONFIG_FILE);
  const fileConfig = loadConfigFile(configFile);
  const cwd = overrides.cwd ?? process.cwd();
  const model =
    overrides.model ??
    process.env.JUNO_MODEL ??
    process.env.OPENAI_MODEL ??
    fileConfig.model ??
    'gpt-5.4-mini';
  const maxSteps =
    overrides.maxSteps ??
    parsePositiveIntEnv('JUNO_MAX_STEPS', process.env.JUNO_MAX_STEPS) ??
    fileConfig.maxSteps ??
    12;
  const toolOutputLimit =
    parsePositiveIntEnv(
      'JUNO_TOOL_OUTPUT_LIMIT',
      process.env.JUNO_TOOL_OUTPUT_LIMIT,
    ) ??
    fileConfig.toolOutputLimit ??
    12000;
  const readLineLimit =
    parsePositiveIntEnv(
      'JUNO_READ_LINE_LIMIT',
      process.env.JUNO_READ_LINE_LIMIT,
    ) ??
    fileConfig.readLineLimit ??
    400;
  const bashTimeoutMs =
    parsePositiveIntEnv(
      'JUNO_BASH_TIMEOUT_MS',
      process.env.JUNO_BASH_TIMEOUT_MS,
    ) ??
    fileConfig.bashTimeoutMs ??
    15000;

  return {
    cwd,
    homeDir,
    authFile: join(homeDir, 'auth.json'),
    sessionsDir: join(homeDir, 'sessions'),
    model,
    apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl:
      overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? fileConfig.baseUrl,
    maxSteps,
    toolOutputLimit,
    readLineLimit,
    bashTimeoutMs,
  };
}
