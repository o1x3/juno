import { join } from 'node:path';

import { DEFAULT_UI } from '@/core/config';
import type { AgentConfig } from '@/types';

export function makeConfig(
  workspace: string,
  overrides: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    cwd: workspace,
    homeDir: workspace,
    configFile: join(workspace, 'config.json'),
    authFile: join(workspace, 'auth.json'),
    sessionsDir: join(workspace, 'sessions'),
    model: 'fake-model',
    planModel: 'fake-plan',
    execModel: 'fake-model',
    namingModel: 'fake-naming',
    autoName: false,
    apiKey: 'unused',
    maxSteps: 4,
    toolOutputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    codexBackendUrl: 'https://chatgpt.com/backend-api',
    ui: { ...DEFAULT_UI },
    autoUpgrade: false,
    updateCheckEnabled: false,
    yoloAcknowledged: false,
    snapshots: false,
    autoCompact: false,
    contextWindow: 272_000,
    compactReserveTokens: 16_384,
    compactKeepRecentTokens: 24_000,
    multiAgent: false,
    multiAgentVersion: 'v2',
    ...overrides,
  };
}
