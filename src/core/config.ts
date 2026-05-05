import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { AgentConfig, UiPreferences } from '@/types';

const DEFAULT_HOME_DIR = join(homedir(), '.juno');
const DEFAULT_CONFIG_FILE = 'config.json';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_PLAN_MODEL = 'gpt-5.4';
const DEFAULT_NAMING_MODEL = 'gpt-5.4-nano';

const uiSchema = z
  .object({
    statusPane: z.enum(['visible', 'hidden']).optional(),
    statusPaneShortcut: z.string().trim().min(1).optional(),
    theme: z.enum(['auto', 'dark', 'light']).optional(),
    timestamps: z.boolean().optional(),
  })
  .strict();

export const configFileSchema = z
  .object({
    model: z.string().trim().min(1).optional(),
    planModel: z.string().trim().min(1).optional(),
    execModel: z.string().trim().min(1).optional(),
    namingModel: z.string().trim().min(1).optional(),
    autoName: z.boolean().optional(),
    baseUrl: z.string().trim().min(1).optional(),
    maxSteps: z.number().int().positive().finite().optional(),
    toolOutputLimit: z.number().int().positive().finite().optional(),
    readLineLimit: z.number().int().positive().finite().optional(),
    bashTimeoutMs: z.number().int().positive().finite().optional(),
    codexBackendUrl: z.string().trim().min(1).optional(),
    codexModel: z.string().trim().min(1).optional(),
    ui: uiSchema.optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

export type ConfigOverrides = {
  cwd?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxSteps?: number;
};

export const DEFAULT_UI: UiPreferences = {
  statusPane: 'visible',
  statusPaneShortcut: 'ctrl+g',
  theme: 'auto',
  timestamps: false,
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

function parseBoolEnv(
  name: string,
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes')
    return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no')
    return false;
  throw new Error(`Invalid environment variable ${name}: expected true/false`);
}

function parseStatusPaneEnv(
  value: string | undefined,
): UiPreferences['statusPane'] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'visible' || normalized === 'on' || normalized === 'true')
    return 'visible';
  if (normalized === 'hidden' || normalized === 'off' || normalized === 'false')
    return 'hidden';
  throw new Error(
    `Invalid environment variable JUNO_UI_STATUS_PANE: expected visible/hidden`,
  );
}

function parseThemeEnv(
  value: string | undefined,
): UiPreferences['theme'] | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'dark' ||
    normalized === 'light'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid environment variable JUNO_UI_THEME: expected auto/dark/light`,
  );
}

function resolveUi(fileUi: ConfigFile['ui']): UiPreferences {
  const statusPane =
    parseStatusPaneEnv(process.env.JUNO_UI_STATUS_PANE) ??
    fileUi?.statusPane ??
    DEFAULT_UI.statusPane;
  const statusPaneShortcut =
    process.env.JUNO_UI_STATUS_PANE_SHORTCUT ??
    fileUi?.statusPaneShortcut ??
    DEFAULT_UI.statusPaneShortcut;
  const theme =
    parseThemeEnv(process.env.JUNO_UI_THEME) ??
    fileUi?.theme ??
    DEFAULT_UI.theme;
  const timestamps =
    parseBoolEnv('JUNO_UI_TIMESTAMPS', process.env.JUNO_UI_TIMESTAMPS) ??
    fileUi?.timestamps ??
    DEFAULT_UI.timestamps;
  return { statusPane, statusPaneShortcut, theme, timestamps };
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
    DEFAULT_MODEL;
  const execModel =
    process.env.JUNO_EXEC_MODEL ?? fileConfig.execModel ?? model;
  const planModel =
    process.env.JUNO_PLAN_MODEL ?? fileConfig.planModel ?? DEFAULT_PLAN_MODEL;
  const namingModel =
    process.env.JUNO_NAMING_MODEL ??
    fileConfig.namingModel ??
    DEFAULT_NAMING_MODEL;
  const autoName =
    parseBoolEnv('JUNO_AUTO_NAME', process.env.JUNO_AUTO_NAME) ??
    fileConfig.autoName ??
    true;
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

  const codexBackendUrl =
    process.env.JUNO_CODEX_BASE_URL ??
    fileConfig.codexBackendUrl ??
    'https://chatgpt.com/backend-api';
  const codexModelOverride =
    process.env.JUNO_CODEX_MODEL ?? fileConfig.codexModel;

  return {
    cwd,
    homeDir,
    configFile,
    authFile: join(homeDir, 'auth.json'),
    sessionsDir: join(homeDir, 'sessions'),
    model,
    planModel,
    execModel,
    namingModel,
    autoName,
    apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl:
      overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? fileConfig.baseUrl,
    maxSteps,
    toolOutputLimit,
    readLineLimit,
    bashTimeoutMs,
    codexBackendUrl,
    codexModelOverride,
    ui: resolveUi(fileConfig.ui),
  };
}

export async function loadConfigFromDisk(
  configFile: string,
): Promise<ConfigFile> {
  return loadConfigFile(configFile);
}

export async function saveConfig(
  configFile: string,
  patch: ConfigFile,
): Promise<ConfigFile> {
  const current = existsSync(configFile) ? loadConfigFile(configFile) : {};
  const merged: ConfigFile = { ...current, ...patch };
  if (patch.ui || current.ui) {
    merged.ui = { ...(current.ui ?? {}), ...(patch.ui ?? {}) };
  }
  const validated = configFileSchema.parse(merged);
  await mkdir(dirname(configFile), { recursive: true });
  await Bun.write(configFile, `${JSON.stringify(validated, null, 2)}\n`);
  return validated;
}
