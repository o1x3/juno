import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentConfig } from '@/types';

const DEFAULT_HOME_DIR = join(homedir(), '.nexus-agent');

export type ConfigOverrides = {
  cwd?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxSteps?: number;
};

export function resolveConfig(overrides: ConfigOverrides = {}): AgentConfig {
  const homeDir = process.env.NEXUS_AGENT_HOME ?? DEFAULT_HOME_DIR;
  const cwd = overrides.cwd ?? process.cwd();
  const model =
    overrides.model ??
    process.env.NEXUS_AGENT_MODEL ??
    process.env.OPENAI_MODEL ??
    'gpt-5.4-mini';

  return {
    cwd,
    homeDir,
    authFile: join(homeDir, 'auth.json'),
    sessionsDir: join(homeDir, 'sessions'),
    model,
    apiKey: overrides.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl: overrides.baseUrl ?? process.env.OPENAI_BASE_URL,
    maxSteps:
      overrides.maxSteps ??
      Number.parseInt(process.env.NEXUS_AGENT_MAX_STEPS ?? '12', 10),
    toolOutputLimit: Number.parseInt(
      process.env.NEXUS_AGENT_TOOL_OUTPUT_LIMIT ?? '12000',
      10,
    ),
    readLineLimit: Number.parseInt(
      process.env.NEXUS_AGENT_READ_LINE_LIMIT ?? '400',
      10,
    ),
    bashTimeoutMs: Number.parseInt(
      process.env.NEXUS_AGENT_BASH_TIMEOUT_MS ?? '15000',
      10,
    ),
  };
}
