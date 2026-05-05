#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import { render } from 'ink';
import { loginWithBrowser, loginWithDeviceCode } from '@/auth/codex';
import { clearCredential, saveCredential } from '@/auth/storage';
import {
  createStoredApiCredential,
  resolveAuthStatus,
  startOrResumeChat,
} from '@/core/chat-service';
import { resolveConfig } from '@/core/config';
import { listSessions } from '@/core/session-store';
import type { AuthStatus } from '@/types';
import { ChatApp } from '@/ui/chat-app';
import { VERSION } from '@/version';

function formatExpiresIn(seconds: number): string {
  const abs = Math.abs(seconds);
  let value: string;
  if (abs >= 3600) {
    value = `${Math.round(abs / 3600)}h`;
  } else if (abs >= 60) {
    value = `${Math.round(abs / 60)}m`;
  } else {
    value = `${abs}s`;
  }
  return seconds >= 0 ? `in ${value}` : `expired ${value} ago`;
}

export function formatAuthStatus(status: AuthStatus): string {
  const lines: string[] = [];
  lines.push(`auth: ${status.authMode}`);

  if (status.authMode === 'none') {
    if (status.source === 'stored') {
      lines.push(
        `note: stored credential at ${status.authFile} could not be used`,
      );
    }
    if (status.hint) {
      lines.push(`hint: ${status.hint}`);
    }
    return `${lines.join('\n')}\n`;
  }

  lines.push(`provider: ${status.provider}`);

  if (status.source === 'env') {
    lines.push('source: env (OPENAI_API_KEY)');
  } else if (status.source === 'stored') {
    lines.push(`source: stored (${status.authFile})`);
  }

  if (status.credentialType === 'oauth') {
    if (status.accountIdPresent && status.accountIdPartial) {
      lines.push(`account: present (${status.accountIdPartial})`);
    } else {
      lines.push('account: missing');
    }

    if (status.expiresAt && status.expiresInSeconds !== undefined) {
      const window = formatExpiresIn(status.expiresInSeconds);
      const flag = status.refreshDueSoon
        ? 'refresh-due-soon: yes'
        : 'refresh-due-soon: no';
      lines.push(`expires: ${status.expiresAt} (${window}, ${flag})`);
    } else if (status.expiresAt) {
      lines.push(`expires: ${status.expiresAt}`);
    }
  }

  lines.push(`model: ${status.activeModel}`);
  if (status.modelFallback) {
    lines.push(
      `fallback: ${status.modelFallback.from} → ${status.modelFallback.to} (${status.modelFallback.source})`,
    );
  }

  return `${lines.join('\n')}\n`;
}

const chatCommand = defineCommand({
  meta: {
    name: 'chat',
    description: 'Start a chat session or run a single prompt.',
  },
  args: {
    prompt: {
      type: 'positional',
      required: false,
    },
    model: {
      type: 'string',
      required: false,
    },
  },
  async run({ args }) {
    const config = resolveConfig({ model: args.model });
    if (args.prompt) {
      const { sessionId, result } = await startOrResumeChat({
        config,
        prompt: String(args.prompt),
      });
      process.stdout.write(`${result.assistantText}\n`);
      process.stdout.write(`session: ${sessionId}\n`);
      process.stdout.write(`auth: ${result.authMode}\n`);
      const fallback = result.modelFallback;
      const fallbackTag = fallback
        ? ` (was ${fallback.from}${fallback.source === 'static' ? '; offline-fallback' : ''})`
        : '';
      process.stdout.write(`model: ${result.activeModel}${fallbackTag}\n`);
      return;
    }

    render(<ChatApp config={config} />);
  },
});

const loginCommand = defineCommand({
  meta: {
    name: 'login',
    description: 'Store Codex credentials locally.',
  },
  args: {
    withApiKey: {
      type: 'boolean',
      default: false,
    },
    browser: {
      type: 'boolean',
      default: false,
    },
    deviceAuth: {
      type: 'boolean',
      default: false,
    },
  },
  async run({ args }) {
    const config = resolveConfig();
    if (args.withApiKey || (!args.browser && !args.deviceAuth)) {
      const apiKey = process.env.OPENAI_API_KEY ?? prompt('OpenAI API key:');
      if (!apiKey) {
        throw new Error('No API key provided.');
      }
      await saveCredential(config.authFile, createStoredApiCredential(apiKey));
      process.stdout.write(`Stored API key in ${config.authFile}\n`);
      return;
    }

    if (args.deviceAuth) {
      const login = await loginWithDeviceCode();
      process.stdout.write(
        `Open ${login.verificationUrl} and enter code ${login.userCode}\n`,
      );
      const credential = await login.credential;
      await saveCredential(config.authFile, credential);
      process.stdout.write(
        `Stored device-auth credential in ${config.authFile}\n`,
      );
      return;
    }

    const login = await loginWithBrowser();
    process.stdout.write(`Open this URL to continue:\n${login.url}\n`);
    const credential = await login.credential;
    await saveCredential(config.authFile, credential);
    process.stdout.write(`Stored OAuth credential in ${config.authFile}\n`);
    if (!credential.apiKey) {
      process.stdout.write(
        'API-key exchange unavailable. Calls will route via the ChatGPT Codex backend using your OAuth credential.\n',
      );
    }
  },
});

const logoutCommand = defineCommand({
  meta: {
    name: 'logout',
    description: 'Clear stored credentials.',
  },
  async run() {
    const config = resolveConfig();
    await clearCredential(config.authFile);
    process.stdout.write(`Cleared ${config.authFile}\n`);
  },
});

const resumeCommand = defineCommand({
  meta: {
    name: 'resume',
    description: 'Resume a previous session in the Ink UI.',
  },
  args: {
    sessionId: {
      type: 'positional',
      required: true,
    },
  },
  async run({ args }) {
    const config = resolveConfig();
    render(<ChatApp config={config} sessionId={String(args.sessionId)} />);
  },
});

const sessionsCommand = defineCommand({
  meta: {
    name: 'sessions',
    description: 'List known sessions.',
  },
  async run() {
    const config = resolveConfig();
    const sessions = await listSessions(config.sessionsDir);
    for (const session of sessions) {
      const name = session.name ?? '';
      process.stdout.write(
        `${session.id}\t${session.updatedAt}\t${session.eventCount}\t${name}\n`,
      );
    }
  },
});

const authStatusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Print current auth, model, and credential status.',
  },
  async run() {
    const config = resolveConfig();
    const status = await resolveAuthStatus(config);
    process.stdout.write(formatAuthStatus(status));
  },
});

const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Auth utilities.',
  },
  subCommands: {
    status: authStatusCommand,
  },
});

const main = defineCommand({
  meta: {
    name: 'juno',
    version: VERSION,
    description: 'Juno, a Codex-first local coding agent.',
  },
  subCommands: {
    chat: chatCommand,
    login: loginCommand,
    logout: logoutCommand,
    resume: resumeCommand,
    sessions: sessionsCommand,
    auth: authCommand,
  },
});

const rawArgs = process.argv.slice(2);
const subCommandNames = new Set(Object.keys(main.subCommands ?? {}));
const firstPositionalArg = rawArgs.find((arg) => !arg.startsWith('-'));

// Handle --version / -v ourselves. Citty routes --version through consola,
// whose basic reporter (used on non-TTY stdout, i.e. CI and piped output)
// prefixes lines with "[log] ". Print the bare version directly so scripts
// can rely on exact-match comparisons.
if (
  rawArgs.length === 1 &&
  (rawArgs[0] === '--version' || rawArgs[0] === '-v')
) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const isMetaInvocation = rawArgs.includes('--help') || rawArgs.includes('-h');

const dispatchArgs =
  isMetaInvocation ||
  (firstPositionalArg && subCommandNames.has(firstPositionalArg))
    ? rawArgs
    : ['chat', ...rawArgs];

if (isMetaInvocation) {
  await runMain(main, { rawArgs: dispatchArgs });
} else {
  try {
    await runCommand(main, { rawArgs: dispatchArgs });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
