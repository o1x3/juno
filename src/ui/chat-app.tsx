import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveAuthSummary, startOrResumeChat } from '@/core/chat-service';
import { type ConfigFile, saveConfig } from '@/core/config';
import { findSessionName, readSessionEvents } from '@/core/session-store';
import { executeShellCommand } from '@/core/tools';
import type {
  AgentConfig,
  AgentMode,
  ModelUsage,
  ToolCall,
  ToolResult,
} from '@/types';
import { filterCommands, parseSlashInput } from '@/ui/commands';
import type { ToolEntry, TranscriptCell } from '@/ui/components/cells';
import { CommandPalette } from '@/ui/components/command-palette';
import { Composer } from '@/ui/components/composer';
import { SettingsPage } from '@/ui/components/settings-page';
import { StatusLine } from '@/ui/components/status-line';
import { STATUS_PANE_WIDTH, StatusPane } from '@/ui/components/status-pane';
import { Transcript } from '@/ui/components/transcript';
import { clampScroll, truncatePath } from '@/ui/format';
import { matchKeybind } from '@/ui/keybinds';
import { computeChatHeight } from '@/ui/layout';
import { colors, glyphs, modeAccent } from '@/ui/theme';

type ChatAppProps = {
  config: AgentConfig;
  initialPrompt?: string;
  sessionId?: string;
};

type StreamingState = {
  active: boolean;
  startedAt: number;
  errorCount: number;
};

function approximateContextLimit(model: string): number {
  if (/(o1|o3|gpt-5|opus|sonnet)/i.test(model)) return 200_000;
  if (/(haiku|nano|mini)/i.test(model)) return 128_000;
  return 128_000;
}

function approximateBreakdown(cells: TranscriptCell[]): {
  system: number;
  user: number;
  assistant: number;
  tool: number;
} {
  const system = 1500;
  let user = 0;
  let assistant = 0;
  let tool = 0;
  for (const cell of cells) {
    if (cell.kind === 'user') user += cell.text.length;
    else if (cell.kind === 'assistant') assistant += cell.text.length;
    else if (cell.kind === 'tool-group')
      tool += cell.tools.reduce(
        (a, t) =>
          a +
          JSON.stringify(t.call.input).length +
          (t.result ? JSON.stringify(t.result.output).length : 0),
        0,
      );
    else if (cell.kind === 'bash-direct')
      tool += cell.stdout.length + cell.stderr.length;
  }
  return {
    system: Math.ceil(system / 4),
    user: Math.ceil(user / 4),
    assistant: Math.ceil(assistant / 4),
    tool: Math.ceil(tool / 4),
  };
}

export function ChatApp({
  config: initialConfig,
  sessionId: resumedSessionId,
}: ChatAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 92;
  const termHeight = stdout?.rows ?? 28;

  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [mode, setMode] = useState<AgentMode>('exec');
  const [bashMode, setBashMode] = useState(false);
  const [paneVisible, setPaneVisible] = useState(
    initialConfig.ui.statusPane === 'visible',
  );
  const [composerValue, setComposerValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cells, setCells] = useState<TranscriptCell[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const stickToBottomRef = useRef(true);

  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(
    resumedSessionId,
  );
  const [sessionName, setSessionName] = useState<string | undefined>(undefined);
  const [activeModel, setActiveModel] = useState(initialConfig.execModel);
  const [streaming, setStreaming] = useState<StreamingState>({
    active: false,
    startedAt: 0,
    errorCount: 0,
  });
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [now, setNow] = useState(Date.now());
  const sessionStartedRef = useRef(Date.now());
  const recentTurnsRef = useRef<number[]>([]);
  const turnUsageRef = useRef<ModelUsage | undefined>(undefined);
  const [turnUsage, setTurnUsage] = useState<ModelUsage | undefined>(undefined);
  const [sessionUsage, setSessionUsage] = useState<ModelUsage | undefined>(
    undefined,
  );

  const [paletteIndex, setPaletteIndex] = useState(0);
  const [draftConfig, setDraftConfig] = useState<ConfigFile>({});

  // Resume: read existing events, populate cells, set name.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (resumedSessionId) {
        try {
          const events = await readSessionEvents(
            initialConfig.sessionsDir,
            resumedSessionId,
          );
          if (cancelled) return;
          const restored: TranscriptCell[] = [];
          for (const event of events) {
            if (event.type === 'user_message') {
              restored.push({
                id: `e-${restored.length}`,
                kind: 'user',
                text: event.message.content,
              });
            } else if (event.type === 'assistant_message') {
              if (event.message.content) {
                restored.push({
                  id: `e-${restored.length}`,
                  kind: 'assistant',
                  text: event.message.content,
                });
              }
            }
          }
          setCells(restored);
          const name = findSessionName(events);
          if (name) setSessionName(name);
        } catch {
          // ignore
        }
      }
      try {
        const summary = await resolveAuthSummary(initialConfig);
        if (cancelled) return;
        setActiveModel(summary.activeModel);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialConfig, resumedSessionId]);

  // Spinner & elapsed ticks while streaming.
  useEffect(() => {
    if (!streaming.active) return;
    const id = setInterval(() => {
      setSpinnerFrame((f) => f + 1);
      setNow(Date.now());
    }, 80);
    return () => clearInterval(id);
  }, [streaming.active]);

  const visualMode = useMemo(() => {
    if (bashMode) return 'bash' as const;
    if (mode === 'plan') return 'plan' as const;
    return 'exec' as const;
  }, [bashMode, mode]);

  const palette = useMemo(() => {
    if (!composerValue.startsWith('/')) return null;
    return filterCommands(composerValue);
  }, [composerValue]);

  const composerVisualMode = palette ? 'palette' : visualMode;

  const appendCell = useCallback((cell: TranscriptCell) => {
    setCells((c) => [...c, cell]);
    if (!stickToBottomRef.current) {
      setUnreadCount((n) => n + 1);
    }
  }, []);

  const updateCell = useCallback(
    (id: string, updater: (c: TranscriptCell) => TranscriptCell) => {
      setCells((current) => current.map((c) => (c.id === id ? updater(c) : c)));
    },
    [],
  );

  const startNewToolGroup = useCallback(() => {
    const id = `tg-${crypto.randomUUID()}`;
    setCells((c) => [
      ...c,
      {
        id,
        kind: 'tool-group',
        tools: [],
        collapsed: false,
        complete: false,
        spinnerFrame: 0,
      },
    ]);
    return id;
  }, []);

  // Turn submission
  const runChatTurn = useCallback(
    async (text: string) => {
      const userCellId = `u-${crypto.randomUUID()}`;
      appendCell({ id: userCellId, kind: 'user', text });
      const toolGroupId = startNewToolGroup();
      const toolEntries = new Map<string, ToolEntry>();
      const turnStartedAt = Date.now();
      turnUsageRef.current = undefined;
      setTurnUsage(undefined);
      setStreaming({ active: true, startedAt: turnStartedAt, errorCount: 0 });

      let assistantCellId: string | undefined;
      const ensureAssistantCell = () => {
        if (assistantCellId) return assistantCellId;
        assistantCellId = `a-${crypto.randomUUID()}`;
        appendCell({
          id: assistantCellId,
          kind: 'assistant',
          text: '',
          streaming: true,
        });
        return assistantCellId;
      };

      try {
        const response = await startOrResumeChat({
          config,
          prompt: text,
          sessionId: activeSessionId,
          mode,
          onSessionName: (name) => setSessionName(name),
          onTextDelta: (delta) => {
            const id = ensureAssistantCell();
            setCells((current) =>
              current.map((c) =>
                c.id === id && c.kind === 'assistant'
                  ? { ...c, text: c.text + delta }
                  : c,
              ),
            );
          },
          onToolCall: (call: ToolCall) => {
            const entry: ToolEntry = {
              call,
              startedAt: Date.now(),
            };
            toolEntries.set(call.toolCallId, entry);
            setCells((current) =>
              current.map((c) =>
                c.id === toolGroupId && c.kind === 'tool-group'
                  ? { ...c, tools: [...c.tools, entry] }
                  : c,
              ),
            );
          },
          onToolResult: (result: ToolResult) => {
            const entry = toolEntries.get(result.toolCallId);
            if (!entry) return;
            entry.result = result;
            entry.endedAt = Date.now();
            if (result.isError) {
              setStreaming((s) => ({ ...s, errorCount: s.errorCount + 1 }));
            }
            setCells((current) =>
              current.map((c) =>
                c.id === toolGroupId && c.kind === 'tool-group'
                  ? {
                      ...c,
                      tools: c.tools.map((t) =>
                        t.call.toolCallId === result.toolCallId
                          ? { ...t, result, endedAt: Date.now() }
                          : t,
                      ),
                    }
                  : c,
              ),
            );
          },
          onUsage: (u) => {
            turnUsageRef.current = u;
            setTurnUsage(u);
          },
        });
        setActiveSessionId(response.sessionId);
        setActiveModel(response.result.activeModel);
        if (assistantCellId) {
          setCells((current) =>
            current.map((c) =>
              c.id === assistantCellId
                ? ({ ...c, streaming: false } as TranscriptCell)
                : c,
            ),
          );
        }
        setCells((current) =>
          current.map((c) =>
            c.id === toolGroupId && c.kind === 'tool-group'
              ? { ...c, complete: true, collapsed: c.tools.length > 0 }
              : c,
          ),
        );
        // remove empty tool group if no tools
        setCells((current) =>
          current.filter(
            (c) =>
              !(
                c.id === toolGroupId &&
                c.kind === 'tool-group' &&
                c.tools.length === 0
              ),
          ),
        );
        // session usage merge
        const responseUsage = response.result.usage;
        if (responseUsage) {
          setSessionUsage((prev) => {
            if (!prev) return responseUsage;
            const u = responseUsage;
            return {
              input: prev.input + u.input,
              output: prev.output + u.output,
              reasoning:
                (prev.reasoning ?? 0) + (u.reasoning ?? 0) || undefined,
              cacheRead:
                (prev.cacheRead ?? 0) + (u.cacheRead ?? 0) || undefined,
              cacheWrite:
                (prev.cacheWrite ?? 0) + (u.cacheWrite ?? 0) || undefined,
              estimated: prev.estimated || u.estimated,
            };
          });
          recentTurnsRef.current = [
            ...recentTurnsRef.current.slice(-5),
            responseUsage.input + responseUsage.output,
          ];
        }
      } catch (error) {
        appendCell({
          id: `e-${crypto.randomUUID()}`,
          kind: 'error',
          title: 'turn failed',
          detail: error instanceof Error ? error.message : String(error),
          actionsHint: '⌃R retry · ⌃X drop & continue',
        });
        setStreaming((s) => ({ ...s, errorCount: s.errorCount + 1 }));
      } finally {
        setStreaming((s) => ({ ...s, active: false }));
      }
    },
    [activeSessionId, appendCell, config, mode, startNewToolGroup],
  );

  const runBashCommand = useCallback(
    async (command: string) => {
      const startedAt = Date.now();
      const cellId = `b-${crypto.randomUUID()}`;
      appendCell({
        id: cellId,
        kind: 'bash-direct',
        command,
        stdout: '',
        stderr: '(running…)',
        exitCode: -1,
        durationMs: 0,
      });
      try {
        const result = await executeShellCommand(command, {
          cwd: config.cwd,
        });
        updateCell(cellId, (c) =>
          c.kind === 'bash-direct'
            ? {
                ...c,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                durationMs: Date.now() - startedAt,
              }
            : c,
        );
        if (result.exitCode !== 0) {
          setStreaming((s) => ({ ...s, errorCount: s.errorCount + 1 }));
        }
      } catch (error) {
        updateCell(cellId, (c) =>
          c.kind === 'bash-direct'
            ? {
                ...c,
                stdout: '',
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: 1,
                durationMs: Date.now() - startedAt,
              }
            : c,
        );
      }
    },
    [appendCell, config.cwd, updateCell],
  );

  const dispatchSlash = useCallback(
    async (name: string, _args: string) => {
      switch (name) {
        case 'exit':
        case 'quit':
          exit();
          return;
        case 'clear':
          setCells([]);
          setUnreadCount(0);
          setScrollOffset(0);
          return;
        case 'settings': {
          // open settings page; load current config file as draft
          try {
            const cf: ConfigFile = {
              model: config.model,
              planModel: config.planModel,
              execModel: config.execModel,
              namingModel: config.namingModel,
              autoName: config.autoName,
              maxSteps: config.maxSteps,
              toolOutputLimit: config.toolOutputLimit,
              readLineLimit: config.readLineLimit,
              bashTimeoutMs: config.bashTimeoutMs,
              ui: { ...config.ui },
            };
            setDraftConfig(cf);
            setView('settings');
          } catch {
            // ignore
          }
          return;
        }
        case 'help':
          appendCell({
            id: `h-${crypto.randomUUID()}`,
            kind: 'plan-note',
            text: [
              'commands:',
              '  /help        this list',
              '  /settings    settings overlay',
              '  /sessions    list sessions',
              '  /model       change model',
              '  /clear       clear transcript',
              '  /rename      rename this session',
              '  /diff        git diff',
              '  /copy        copy last assistant message',
              '  /exit        quit',
              '',
              'keys:',
              '  Shift+Tab    toggle plan / exec',
              '  !            bash mode (when composer empty)',
              '  Ctrl+J       newline',
              '  Ctrl+G       toggle status pane',
              '  PgUp / PgDn  scroll transcript',
              '  Home / End   jump top / bottom',
            ].join('\n'),
          });
          return;
        case 'sessions':
          // delegate: print a hint cell pointing at the CLI
          appendCell({
            id: `s-${crypto.randomUUID()}`,
            kind: 'plan-note',
            text: 'sessions live under ~/.juno/sessions — use `juno sessions` from the shell to list them, then `juno resume <id>`.',
          });
          return;
        case 'rename': {
          appendCell({
            id: `r-${crypto.randomUUID()}`,
            kind: 'plan-note',
            text: 'rename: type the new name as a /rename argument, e.g. `/rename refactor-tokens`',
          });
          return;
        }
        case 'diff': {
          await runBashCommand('git diff --no-color');
          return;
        }
        case 'copy': {
          const lastAssistant = [...cells]
            .reverse()
            .find(
              (c): c is Extract<TranscriptCell, { kind: 'assistant' }> =>
                c.kind === 'assistant',
            );
          if (!lastAssistant) {
            appendCell({
              id: `c-${crypto.randomUUID()}`,
              kind: 'plan-note',
              text: 'no assistant message to copy yet',
            });
            return;
          }
          // Best-effort: print to a tagged plan-note so user can select-copy.
          appendCell({
            id: `c-${crypto.randomUUID()}`,
            kind: 'plan-note',
            text:
              'last assistant message (select to copy):\n\n' +
              lastAssistant.text,
          });
          return;
        }
        case 'model':
          appendCell({
            id: `m-${crypto.randomUUID()}`,
            kind: 'plan-note',
            text: `current models: exec=${config.execModel}, plan=${config.planModel}. Use /settings to change.`,
          });
          return;
        default:
          appendCell({
            id: `u-${crypto.randomUUID()}`,
            kind: 'error',
            title: 'unknown command',
            detail: `/${name}`,
          });
      }
    },
    [appendCell, cells, config, exit, runBashCommand],
  );

  // Submit handler — depends on dispatchSlash and runBashCommand defined above.
  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setHistory((h) => [...h.slice(-49), trimmed]);
      setComposerValue('');

      if (trimmed.startsWith('/')) {
        const parsed = parseSlashInput(trimmed);
        await dispatchSlash(parsed.name, parsed.args);
        return;
      }

      if (bashMode) {
        await runBashCommand(trimmed);
        return;
      }

      await runChatTurn(trimmed);
    },
    [bashMode, dispatchSlash, runBashCommand, runChatTurn],
  );

  // Bash-mode toggle: composer-driven. We watch composer value to switch.
  useEffect(() => {
    if (composerValue.startsWith('!') && !bashMode && !palette) {
      setBashMode(true);
      setComposerValue(composerValue.slice(1));
    }
  }, [composerValue, bashMode, palette]);

  // Global keybinds (scrollback, pane toggle, view-level)
  useInput(
    (input, key) => {
      if (view === 'settings') return;
      if (matchKeybind('pane-toggle', input, key)) {
        setPaneVisible((v) => !v);
        return;
      }
      if (matchKeybind('cancel-turn', input, key)) {
        if (streaming.active) {
          setStreaming((s) => ({ ...s, active: false }));
        } else {
          exit();
        }
        return;
      }
      if (key.pageUp) {
        setScrollOffset((o) => clampScroll(o + 5, cells.length));
        stickToBottomRef.current = false;
        return;
      }
      if (key.pageDown) {
        setScrollOffset((o) => clampScroll(o - 5, cells.length));
        if (scrollOffset - 5 <= 0) {
          stickToBottomRef.current = true;
          setUnreadCount(0);
        }
        return;
      }
      if (key.home) {
        setScrollOffset(cells.length);
        stickToBottomRef.current = false;
        return;
      }
      if (key.end) {
        setScrollOffset(0);
        stickToBottomRef.current = true;
        setUnreadCount(0);
        return;
      }
      if (key.ctrl && input === 't') {
        // expand most recent collapsed tool group
        setCells((current) => {
          const idx = [...current]
            .map((c, i) => ({ c, i }))
            .reverse()
            .find(
              ({ c }) =>
                c.kind === 'tool-group' &&
                (c as { collapsed?: boolean }).collapsed,
            )?.i;
          if (idx === undefined) return current;
          return current.map((c, i) =>
            i === idx && c.kind === 'tool-group'
              ? { ...c, collapsed: false }
              : c,
          );
        });
      }
    },
    { isActive: view === 'chat' },
  );

  // Render settings view
  if (view === 'settings') {
    return (
      <SettingsPage
        current={draftConfig}
        draft={draftConfig}
        onChange={setDraftConfig}
        onSave={async () => {
          await saveConfig(config.configFile, draftConfig);
          // update in-memory config: re-merge fields manually
          setConfig({
            ...config,
            execModel: draftConfig.execModel ?? config.execModel,
            planModel: draftConfig.planModel ?? config.planModel,
            namingModel: draftConfig.namingModel ?? config.namingModel,
            autoName: draftConfig.autoName ?? config.autoName,
            maxSteps: draftConfig.maxSteps ?? config.maxSteps,
            toolOutputLimit:
              draftConfig.toolOutputLimit ?? config.toolOutputLimit,
            bashTimeoutMs: draftConfig.bashTimeoutMs ?? config.bashTimeoutMs,
            ui: {
              ...config.ui,
              ...(draftConfig.ui ?? {}),
            },
          });
          setView('chat');
        }}
        onCancel={() => setView('chat')}
        authNote="manage credentials with `juno auth status` / `juno login` / `juno logout`"
      />
    );
  }

  // Layout math
  const showPane = paneVisible && termWidth >= 100;
  const chatWidth = showPane ? termWidth - STATUS_PANE_WIDTH - 2 : termWidth;
  // header(1) + separator(1) + composer(1+) + spacer(1) + status(1) + hint(1)
  // = 6 fixed rows; leave 2 slack for multiline composer expansion.
  const chatHeight = computeChatHeight(termHeight);

  const breakdown = approximateBreakdown(cells);
  const ctxLimit = approximateContextLimit(activeModel);
  const ctxUsed = sessionUsage
    ? sessionUsage.input + sessionUsage.output
    : breakdown.system + breakdown.user + breakdown.assistant + breakdown.tool;
  const turnDurationMs = streaming.active ? now - streaming.startedAt : 0;
  const lastTurnEntry = cells.find(
    (c) => c.kind === 'tool-group' && (c as { complete: boolean }).complete,
  );

  const headerColor = modeAccent(visualMode);
  const headerDot = visualMode === 'plan' ? glyphs.plan : '●';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" paddingX={1}>
        <Text color={colors.accent} bold>
          juno
        </Text>
        <Text color={colors.dim}>
          {sessionName ? `  · ${sessionName}` : ''}
          {`  · ${truncatePath(config.cwd, 40)}`}
        </Text>
        <Box flexGrow={1} />
        <Text color={headerColor}>{`${visualMode}  ${headerDot}`}</Text>
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width={chatWidth} height={chatHeight}>
          <Transcript
            cells={cells}
            width={chatWidth}
            height={chatHeight}
            scrollOffset={scrollOffset}
            unreadCount={unreadCount}
          />
        </Box>
        {showPane && (
          <Box marginLeft={1}>
            <StatusPane
              mode={visualMode}
              model={activeModel}
              contextLimit={ctxLimit}
              contextUsed={ctxUsed}
              estimated={Boolean(
                sessionUsage?.estimated || turnUsage?.estimated,
              )}
              breakdown={breakdown}
              turnUsage={turnUsage}
              turnDurationMs={turnDurationMs}
              sessionUsage={sessionUsage}
              sessionStartedMs={sessionStartedRef.current}
              recentTurns={recentTurnsRef.current}
              toolsThisTurn={
                lastTurnEntry && lastTurnEntry.kind === 'tool-group'
                  ? lastTurnEntry.tools.map((t) => ({
                      name: t.call.toolName,
                      durationMs: (t.endedAt ?? Date.now()) - t.startedAt,
                      status: !t.result
                        ? ('running' as const)
                        : t.result.isError
                          ? ('fail' as const)
                          : ('ok' as const),
                    }))
                  : []
              }
            />
          </Box>
        )}
      </Box>

      {palette && composerValue.startsWith('/') && (
        <CommandPalette items={palette} selectedIndex={paletteIndex} />
      )}

      <Composer
        value={composerValue}
        visualMode={composerVisualMode}
        width={termWidth}
        history={history}
        placeholder={
          bashMode
            ? 'shell command…'
            : palette
              ? 'type a command…'
              : mode === 'plan'
                ? 'plan: read-only, no edits'
                : 'message juno…  (Shift+Tab plan · ! bash · / commands)'
        }
        isActive={view === 'chat'}
        paletteOpen={Boolean(palette)}
        onChange={(v) => {
          setComposerValue(v);
          setPaletteIndex(0);
        }}
        onSubmit={(v) => {
          void handleSubmit(v);
        }}
        onCancel={() => {
          if (palette) {
            setComposerValue('');
            setPaletteIndex(0);
          }
        }}
        onEmptyBackspace={() => {
          if (bashMode) setBashMode(false);
        }}
        onModeToggle={() => {
          if (bashMode) return;
          setMode((m) => (m === 'plan' ? 'exec' : 'plan'));
        }}
        onPaletteNav={(direction) => {
          if (!palette || palette.length === 0) return;
          setPaletteIndex((i) => {
            if (direction === 'up')
              return (i - 1 + palette.length) % palette.length;
            return (i + 1) % palette.length;
          });
        }}
        onPaletteAccept={() => {
          if (!palette || palette.length === 0) return;
          const selected = palette[paletteIndex] ?? palette[0];
          if (selected) setComposerValue(`/${selected.name} `);
        }}
      />

      <Box height={1}>
        <Text> </Text>
      </Box>

      <Box paddingX={1}>
        <StatusLine
          mode={visualMode}
          model={activeModel}
          streaming={streaming.active}
          spinnerFrame={spinnerFrame}
          elapsedMs={turnDurationMs}
          usage={sessionUsage}
          contextLimit={ctxLimit}
          sessionName={sessionName}
          errorCount={streaming.errorCount}
        />
      </Box>
      <Box paddingX={1}>
        <Text color={colors.dim} dimColor>
          {bashMode
            ? '⏎ run · ⌃J newline · ⌫ exit bash · ⌃C abort · ↑↓ history'
            : palette
              ? '⏎ run command · ⎋ cancel'
              : '⏎ send · ⌃J newline · ⇧⇥ plan/exec · ! bash · / commands · ⌃G pane · ⌃C ✕'}
        </Text>
      </Box>
    </Box>
  );
}
