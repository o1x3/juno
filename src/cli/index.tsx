#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import { render } from 'ink';
import { loginWithBrowser, loginWithDeviceCode } from '@/auth/codex';
import { clearCredential, saveCredential } from '@/auth/storage';
import {
  createStoredApiCredential,
  startOrResumeChat,
} from '@/core/chat-service';
import { resolveConfig } from '@/core/config';
import { listSessions } from '@/core/session-store';
import { ChatApp } from '@/ui/chat-app';

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
      process.stdout.write(
        `${session.id}\t${session.updatedAt}\t${session.eventCount}\n`,
      );
    }
  },
});

const main = defineCommand({
  meta: {
    name: 'juno',
    description: 'Juno, a Codex-first local coding agent.',
  },
  subCommands: {
    chat: chatCommand,
    login: loginCommand,
    logout: logoutCommand,
    resume: resumeCommand,
    sessions: sessionsCommand,
  },
});

const rawArgs = process.argv.slice(2);
const subCommandNames = new Set(Object.keys(main.subCommands ?? {}));
const firstPositionalArg = rawArgs.find((arg) => !arg.startsWith('-'));
const isMetaInvocation =
  rawArgs.includes('--help') ||
  rawArgs.includes('-h') ||
  (rawArgs.length === 1 && rawArgs[0] === '--version');

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
