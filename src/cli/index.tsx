#!/usr/bin/env bun
import { defineCommand, runCommand, runMain } from 'citty';
import { render } from 'ink';
import type React from 'react';
import { loginWithBrowser, loginWithDeviceCode } from '@/auth/codex';
import { clearCredential, saveCredential } from '@/auth/storage';
import {
  createStoredApiCredential,
  resolveAuthStatus,
  startOrResumeChat,
} from '@/core/chat-service';
import { resolveConfig } from '@/core/config';
import { listSessions } from '@/core/session-store';
import {
  performUninstall,
  removePathBlockFromShellRcs,
} from '@/core/uninstall';
import {
  detectInstallContext,
  fetchLatestTag,
  performUpgrade,
  rollbackBinary,
  stripV,
} from '@/core/upgrade';
import type { AuthStatus } from '@/types';
import { ChatApp } from '@/ui/chat-app';
import { VERSION } from '@/version';

async function renderFullscreen(node: React.ReactElement): Promise<void> {
  process.stdout.write('\x1b[?1049h'); // enter alternate screen
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write('\x1b[?1049l'); // exit alternate screen
  };
  process.on('exit', restore);
  const instance = render(node);
  await instance.waitUntilExit();
  restore();
  process.off('exit', restore);
}

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

    await renderFullscreen(<ChatApp config={config} />);
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
    await renderFullscreen(
      <ChatApp config={config} sessionId={String(args.sessionId)} />,
    );
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

const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Self-update juno to the latest release.',
  },
  args: {
    check: {
      type: 'boolean',
      description: 'Only print current and latest versions; do not upgrade.',
    },
    version: {
      type: 'string',
      description: 'Install a specific tag (e.g. v0.2.1) instead of latest.',
    },
    yes: {
      type: 'boolean',
      description: 'Non-interactive; do not prompt.',
    },
    rollback: {
      type: 'boolean',
      description: 'Restore the previously installed binary (.old).',
    },
  },
  async run({ args }) {
    const execPath = process.execPath;

    if (args.rollback) {
      const result = rollbackBinary(execPath);
      process.stdout.write(
        `rolled back to previous binary at ${result.restored}\n`,
      );
      return;
    }

    if (args.check) {
      const tag = await fetchLatestTag({});
      const latest = stripV(tag);
      const current = VERSION;
      const status =
        latest === current
          ? 'up-to-date'
          : `newer available (run: juno upgrade)`;
      process.stdout.write(
        `current: ${current}\nlatest:  ${latest}\nstatus:  ${status}\n`,
      );
      return;
    }

    const ctx = detectInstallContext(execPath);
    if (ctx.kind === 'homebrew' || ctx.kind === 'npm') {
      process.stdout.write(
        `juno is installed via ${ctx.kind}. Run: ${ctx.command}\n`,
      );
      return;
    }
    if (ctx.kind === 'standalone' && !ctx.writable) {
      process.stderr.write(
        `juno is installed at ${ctx.execPath} but is not writable by the current user.\n` +
          `Re-run as the install owner, or reinstall with: curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/install.sh | sh\n`,
      );
      process.exitCode = 1;
      return;
    }

    const outcome = await performUpgrade({
      current: VERSION,
      targetTag: args.version,
      execPath,
    });

    switch (outcome.status) {
      case 'up-to-date':
        process.stdout.write(
          `already at latest version (${outcome.current})\n`,
        );
        return;
      case 'managed':
        if (
          outcome.context.kind === 'homebrew' ||
          outcome.context.kind === 'npm'
        ) {
          process.stdout.write(
            `juno is managed by ${outcome.context.kind}; run: ${outcome.context.command}\n`,
          );
        }
        return;
      case 'not-writable':
        process.stderr.write(
          `auto-upgrade failed: ${outcome.execPath} is not writable\n`,
        );
        process.exitCode = 1;
        return;
      case 'upgraded':
        process.stdout.write(
          `upgraded ${outcome.from} → ${outcome.to}\nbinary: ${outcome.execPath}\nprevious kept at: ${outcome.backupPath}\n`,
        );
        return;
    }
  },
});

const uninstallCommand = defineCommand({
  meta: {
    name: 'uninstall',
    description: 'Remove the juno binary and (optionally) all local data.',
  },
  args: {
    purge: {
      type: 'boolean',
      description: 'Also remove $JUNO_HOME (sessions, auth, config).',
    },
    'keep-config': {
      type: 'boolean',
      description: 'Keep $JUNO_HOME even if it exists (default).',
    },
    yes: {
      type: 'boolean',
      description: 'Non-interactive; do not prompt.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print what would be removed; do nothing.',
    },
  },
  async run({ args }) {
    const config = resolveConfig();
    const execPath = process.execPath;
    const ctx = detectInstallContext(execPath);

    if (ctx.kind === 'homebrew' || ctx.kind === 'npm') {
      process.stdout.write(
        `juno is installed via ${ctx.kind}; uninstall with: ${ctx.command.replace('upgrade', 'uninstall').replace('install -g', 'uninstall -g')}\n`,
      );
      return;
    }

    const plan = {
      binary: ctx.execPath,
      backup: `${ctx.execPath}.old`,
      home: args.purge ? config.homeDir : undefined,
    };

    process.stdout.write(
      `will remove:\n  ${plan.binary}\n  ${plan.backup} (if present)\n`,
    );
    if (plan.home) {
      process.stdout.write(`  ${plan.home} (--purge)\n`);
    }

    if (args['dry-run']) {
      const removed = removePathBlockFromShellRcs({ dryRun: true });
      if (removed.length) {
        process.stdout.write(
          `would clean PATH block from: ${removed.join(', ')}\n`,
        );
      }
      return;
    }

    if (!args.yes) {
      const answer =
        typeof globalThis.prompt === 'function'
          ? globalThis.prompt('Proceed? [y/N] ')
          : null;
      if (!answer || !/^y(es)?$/i.test(answer.trim())) {
        process.stdout.write('aborted\n');
        return;
      }
    }

    const result = await performUninstall({
      execPath: ctx.execPath,
      homeDir: plan.home,
    });
    const cleaned = removePathBlockFromShellRcs({ dryRun: false });

    for (const removed of result.removed) {
      process.stdout.write(`removed: ${removed}\n`);
    }
    for (const file of cleaned) {
      process.stdout.write(`cleaned PATH block from: ${file}\n`);
    }
    process.stdout.write('uninstalled.\n');
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
    upgrade: upgradeCommand,
    uninstall: uninstallCommand,
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
