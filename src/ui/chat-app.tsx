import { join } from 'node:path';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addToolApprovalForever,
  isToolApprovedForever,
  loadApprovalAllowlist,
  saveApprovalAllowlist,
} from '@/core/approvals';
import { resolveAuthSummary, startOrResumeChat } from '@/core/chat-service';
import { type ConfigFile, saveConfig } from '@/core/config';
import {
  findLatestPlan,
  findSessionName,
  readSessionEvents,
} from '@/core/session-store';
import { executeShellCommand } from '@/core/tools';
import {
  checkForUpdate,
  detectInstallContext,
  performUpgrade,
} from '@/core/upgrade';
import type {
  AgentConfig,
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  ModelUsage,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  TodoItem,
  ToolCall,
  ToolName,
  ToolResult,
} from '@/types';
import { filterCommands, parseSlashInput } from '@/ui/commands';
import {
  summarizePlanCounts,
  type ToolEntry,
  type TranscriptCell,
} from '@/ui/components/cells';
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
import { VERSION } from '@/version';

const STALE_PLAN_TURN_THRESHOLD = 4;

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
  const [currentPlan, setCurrentPlan] = useState<TodoItem[]>([]);
  const [turnsSincePlanUpdate, setTurnsSincePlanUpdate] = useState<number>(
    Number.POSITIVE_INFINITY,
  );
  const [upgradeStatus, setUpgradeStatus] = useState<string | undefined>(
    undefined,
  );

  type PendingApproval = {
    cellId: string;
    resolve: (decision: ApprovalDecision) => void;
  };
  type PendingQuestion = {
    cellId: string;
    request: QuestionRequest;
    resolve: (response: QuestionResponse) => void;
  };
  type PendingConfirmation = {
    cellId: string;
    resolve: (confirmed: boolean) => void;
  };

  const pendingApprovalRef = useRef<PendingApproval | null>(null);
  const [pendingApprovalCellId, setPendingApprovalCellId] = useState<
    string | null
  >(null);
  const pendingQuestionRef = useRef<PendingQuestion | null>(null);
  const [pendingQuestionCellId, setPendingQuestionCellId] = useState<
    string | null
  >(null);
  const pendingConfirmationRef = useRef<PendingConfirmation | null>(null);
  const [pendingConfirmationCellId, setPendingConfirmationCellId] = useState<
    string | null
  >(null);

  const sessionApprovalsRef = useRef<Set<ToolName>>(new Set());
  const [approvalStore, setApprovalStore] = useState<
    Record<string, ToolName[]>
  >({});
  const approvalStoreRef = useRef<Record<string, ToolName[]>>({});
  useEffect(() => {
    approvalStoreRef.current = approvalStore;
  }, [approvalStore]);

  useEffect(() => {
    let cancelled = false;
    void loadApprovalAllowlist(initialConfig.homeDir).then((store) => {
      if (!cancelled) setApprovalStore(store);
    });
    return () => {
      cancelled = true;
    };
  }, [initialConfig.homeDir]);

  const promptPending = Boolean(
    pendingApprovalCellId ?? pendingQuestionCellId ?? pendingConfirmationCellId,
  );

  // Background update check (and silent auto-upgrade if enabled).
  useEffect(() => {
    if (!config.updateCheckEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const cachePath = join(config.homeDir, 'version.json');
        const check = await checkForUpdate({
          current: VERSION,
          cachePath,
        });
        if (cancelled || !check.hasUpdate || check.dismissed) return;
        if (!config.autoUpgrade) {
          setUpgradeStatus(
            `update available: v${check.latest} — run juno upgrade`,
          );
          return;
        }
        const ctx = detectInstallContext();
        if (ctx.kind !== 'standalone') {
          setUpgradeStatus(
            `update available: v${check.latest} — managed install, run \`${ctx.kind === 'homebrew' ? ctx.command : ctx.kind === 'npm' ? ctx.command : 'juno upgrade'}\``,
          );
          return;
        }
        if (!ctx.writable) {
          setUpgradeStatus(
            `auto-upgrade disabled: ${ctx.execPath} not writable`,
          );
          return;
        }
        setUpgradeStatus(`upgrading to v${check.latest}…`);
        try {
          const outcome = await performUpgrade({
            current: VERSION,
            cachePath,
          });
          if (cancelled) return;
          if (outcome.status === 'upgraded') {
            setUpgradeStatus(
              `upgraded to v${outcome.to} (active on next launch)`,
            );
          } else if (outcome.status === 'up-to-date') {
            setUpgradeStatus(undefined);
          } else if (outcome.status === 'not-writable') {
            setUpgradeStatus(
              `auto-upgrade failed: ${outcome.execPath} not writable`,
            );
          }
        } catch (error) {
          if (cancelled) return;
          const reason = error instanceof Error ? error.message : String(error);
          setUpgradeStatus(`auto-upgrade failed: ${reason}`);
        }
      } catch {
        // Network errors etc are silent — never block the TUI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config.updateCheckEnabled, config.autoUpgrade, config.homeDir]);

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
          const latestPlan = findLatestPlan(events);
          if (latestPlan && latestPlan.length > 0) {
            restored.push({
              id: `e-${restored.length}-plan`,
              kind: 'todo',
              todos: latestPlan,
            });
            setCurrentPlan(latestPlan);
          } else if (latestPlan) {
            setCurrentPlan([]);
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
    if (mode === 'yolo') return 'yolo' as const;
    return 'exec' as const;
  }, [bashMode, mode]);

  const palette = useMemo(() => {
    if (!composerValue.startsWith('/')) return null;
    return filterCommands(composerValue);
  }, [composerValue]);

  const composerVisualMode = palette ? 'palette' : visualMode;

  const planCounts = useMemo(() => {
    if (currentPlan.length === 0) return undefined;
    const s = summarizePlanCounts(currentPlan);
    return { ...s, total: currentPlan.length };
  }, [currentPlan]);

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
      },
    ]);
    return id;
  }, []);

  const requestApproval = useCallback(
    async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      if (sessionApprovalsRef.current.has(req.toolName)) {
        return 'approve';
      }
      if (
        isToolApprovedForever(
          approvalStoreRef.current,
          config.cwd,
          req.toolName,
        )
      ) {
        return 'approve';
      }
      const cellId = `ap-${crypto.randomUUID()}`;
      appendCell({
        id: cellId,
        kind: 'approval',
        toolName: req.toolName,
        preview: req.preview,
        status: 'pending',
        selectedIndex: 0,
        feedback: '',
        focusMode: 'options',
        expandDiff: false,
      });
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        pendingApprovalRef.current = { cellId, resolve };
        setPendingApprovalCellId(cellId);
      });
      pendingApprovalRef.current = null;
      setPendingApprovalCellId(null);

      const isReject =
        decision === 'reject' ||
        (typeof decision === 'object' && decision.decision === 'reject');
      const isForever = decision === 'approve_forever';
      const isApprove = decision === 'approve';
      const settledStatus = isApprove
        ? 'approved'
        : isForever
          ? 'approved_forever'
          : 'rejected';
      const rejectionReason =
        typeof decision === 'object' &&
        decision.decision === 'reject' &&
        decision.reason
          ? decision.reason
          : undefined;
      setCells((current) =>
        current.map((cell) =>
          cell.id === cellId && cell.kind === 'approval'
            ? { ...cell, status: settledStatus, rejectionReason }
            : cell,
        ),
      );

      if (!isReject) {
        sessionApprovalsRef.current.add(req.toolName);
      }
      if (isForever) {
        const next = addToolApprovalForever(
          approvalStoreRef.current,
          config.cwd,
          req.toolName,
        );
        approvalStoreRef.current = next;
        setApprovalStore(next);
        void saveApprovalAllowlist(config.homeDir, next).catch(() => {
          // best-effort; if the disk write fails we still honor the session cache
        });
      }
      return decision;
    },
    [appendCell, config.cwd, config.homeDir],
  );

  const requestUserAnswer = useCallback(
    async (req: QuestionRequest): Promise<QuestionResponse> => {
      const baseOptions: QuestionOption[] = req.options.slice();
      const options =
        req.allowCustom !== false
          ? [
              ...baseOptions,
              {
                label: 'Other',
                description: 'Type a custom answer (Tab to enter notes).',
              },
            ]
          : baseOptions;
      const cellId = `q-${crypto.randomUUID()}`;
      appendCell({
        id: cellId,
        kind: 'question',
        questionId: req.questionId,
        question: req.question,
        header: req.header,
        options,
        multiSelect: Boolean(req.multiSelect),
        status: 'pending',
        selectedIndices: [],
        focusMode: 'options',
        notes: '',
        cursor: 0,
        isSecret: Boolean(req.isSecret),
        progress: req.progress,
      });
      const response = await new Promise<QuestionResponse>((resolve) => {
        pendingQuestionRef.current = { cellId, request: req, resolve };
        setPendingQuestionCellId(cellId);
      });
      pendingQuestionRef.current = null;
      setPendingQuestionCellId(null);

      setCells((current) =>
        current.map((cell) =>
          cell.id === cellId && cell.kind === 'question'
            ? {
                ...cell,
                status: response.kind === 'answered' ? 'answered' : 'dismissed',
                answer: response,
              }
            : cell,
        ),
      );

      return response;
    },
    [appendCell],
  );

  const enterYolo = useCallback(() => {
    setMode('yolo');
    appendCell({
      id: `yb-${crypto.randomUUID()}`,
      kind: 'plan-note',
      text: '⚠ yolo · approvals off',
    });
  }, [appendCell]);

  const tryEnterYolo = useCallback(async () => {
    if (config.yoloAcknowledged) {
      enterYolo();
      return;
    }
    const cellId = `cf-${crypto.randomUUID()}`;
    appendCell({
      id: cellId,
      kind: 'confirmation',
      title: 'yolo mode',
      body: [
        'In yolo mode Juno will skip every approval prompt.',
        'File writes, edits, and shell commands run immediately.',
        '',
        'You can leave yolo any time with Shift+Tab.',
      ].join('\n'),
      status: 'pending',
    });
    const confirmed = await new Promise<boolean>((resolve) => {
      pendingConfirmationRef.current = { cellId, resolve };
      setPendingConfirmationCellId(cellId);
    });
    pendingConfirmationRef.current = null;
    setPendingConfirmationCellId(null);
    setCells((current) =>
      current.map((cell) =>
        cell.id === cellId && cell.kind === 'confirmation'
          ? { ...cell, status: confirmed ? 'confirmed' : 'cancelled' }
          : cell,
      ),
    );
    if (confirmed) {
      try {
        await saveConfig(config.configFile, { yoloAcknowledged: true });
      } catch {
        // best-effort: if we can't persist, still enter yolo this session
      }
      setConfig((c) => ({ ...c, yoloAcknowledged: true }));
      enterYolo();
    }
  }, [appendCell, config.configFile, config.yoloAcknowledged, enterYolo]);

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
          requestApproval: mode === 'yolo' ? undefined : requestApproval,
          requestUserAnswer,
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
            if (result.toolName === 'TodoWrite' && !result.isError) {
              const todos = (
                result.output as { todos?: TodoItem[] } | undefined
              )?.todos;
              if (Array.isArray(todos)) {
                setCurrentPlan(todos);
                setTurnsSincePlanUpdate(0);
                appendCell({
                  id: `td-${result.toolCallId}`,
                  kind: 'todo',
                  todos,
                });
              }
            }
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
              ? { ...c, complete: true, collapsed: false }
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
        setTurnsSincePlanUpdate((n) => (Number.isFinite(n) ? n + 1 : n));
      }
    },
    [
      activeSessionId,
      appendCell,
      config,
      mode,
      requestApproval,
      requestUserAnswer,
      startNewToolGroup,
    ],
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
              '  /todos       show current plan',
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
        case 'todos':
          if (currentPlan.length === 0) {
            appendCell({
              id: `t-${crypto.randomUUID()}`,
              kind: 'plan-note',
              text: 'no plan yet — TodoWrite has not been called in this session.',
            });
          } else {
            appendCell({
              id: `t-${crypto.randomUUID()}`,
              kind: 'todo',
              todos: currentPlan,
            });
          }
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
    [appendCell, cells, config, currentPlan, exit, runBashCommand],
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
        return;
      }
      if (matchKeybind('todo-toggle', input, key)) {
        // toggle the most recent todo cell expanded/collapsed
        setCells((current) => {
          const idx = [...current]
            .map((c, i) => ({ c, i }))
            .reverse()
            .find(({ c }) => c.kind === 'todo')?.i;
          if (idx === undefined) return current;
          return current.map((c, i) =>
            i === idx && c.kind === 'todo'
              ? { ...c, collapsed: !c.collapsed }
              : c,
          );
        });
      }
    },
    { isActive: view === 'chat' },
  );

  // Prompt routing: when an approval / question / confirmation cell is
  // pending, route keystrokes to it before they reach the composer.
  useInput(
    (input, key) => {
      // Confirmation (yolo onboarding): y / n / Esc
      if (pendingConfirmationCellId && pendingConfirmationRef.current) {
        if (input === 'y' || input === 'Y') {
          pendingConfirmationRef.current.resolve(true);
          return;
        }
        if (input === 'n' || input === 'N' || key.escape) {
          pendingConfirmationRef.current.resolve(false);
          return;
        }
        return;
      }

      // Approval: y/a/n + 1/2/3 + arrows + Enter + Esc + Tab-to-feedback
      if (pendingApprovalCellId && pendingApprovalRef.current) {
        const pending = pendingApprovalRef.current;
        const current = cells.find(
          (c) => c.id === pendingApprovalCellId && c.kind === 'approval',
        );
        if (!current || current.kind !== 'approval') return;
        const trimmedFeedback = current.feedback.trim();

        const resolveReject = () => {
          if (trimmedFeedback.length > 0) {
            pending.resolve({ decision: 'reject', reason: trimmedFeedback });
          } else {
            pending.resolve('reject');
          }
        };
        const resolveByIdx = (idx: number) => {
          if (idx === 0) pending.resolve('approve');
          else if (idx === 1) pending.resolve('approve_forever');
          else resolveReject();
        };

        // ⌃F toggles the fullscreen / expanded diff view in either focus mode.
        if (key.ctrl && input === 'f') {
          setCells((all) =>
            all.map((c) =>
              c.id === pendingApprovalCellId && c.kind === 'approval'
                ? { ...c, expandDiff: !c.expandDiff }
                : c,
            ),
          );
          return;
        }

        if (current.focusMode === 'feedback') {
          if (key.tab) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingApprovalCellId && c.kind === 'approval'
                  ? { ...c, focusMode: 'options' }
                  : c,
              ),
            );
            return;
          }
          if (key.escape) {
            // Esc in feedback mode rejects without the reason.
            pending.resolve('reject');
            return;
          }
          if (key.return) {
            resolveByIdx(current.selectedIndex);
            return;
          }
          if (key.backspace || key.delete) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingApprovalCellId && c.kind === 'approval'
                  ? { ...c, feedback: c.feedback.slice(0, -1) }
                  : c,
              ),
            );
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingApprovalCellId && c.kind === 'approval'
                  ? { ...c, feedback: c.feedback + input }
                  : c,
              ),
            );
          }
          return;
        }

        // options focus
        if (key.tab) {
          setCells((all) =>
            all.map((c) =>
              c.id === pendingApprovalCellId && c.kind === 'approval'
                ? { ...c, focusMode: 'feedback', selectedIndex: 2 }
                : c,
            ),
          );
          return;
        }
        if (input === 'y' || input === 'Y' || input === '1') {
          pending.resolve('approve');
          return;
        }
        if (input === 'a' || input === 'A' || input === '2') {
          pending.resolve('approve_forever');
          return;
        }
        if (input === 'n' || input === 'N' || input === '3' || key.escape) {
          resolveReject();
          return;
        }
        if (key.upArrow || input === 'k') {
          setCells((all) =>
            all.map((cell) =>
              cell.id === pendingApprovalCellId && cell.kind === 'approval'
                ? {
                    ...cell,
                    selectedIndex: (cell.selectedIndex + 2) % 3,
                  }
                : cell,
            ),
          );
          return;
        }
        if (key.downArrow || input === 'j') {
          setCells((all) =>
            all.map((cell) =>
              cell.id === pendingApprovalCellId && cell.kind === 'approval'
                ? {
                    ...cell,
                    selectedIndex: (cell.selectedIndex + 1) % 3,
                  }
                : cell,
            ),
          );
          return;
        }
        if (key.return) {
          resolveByIdx(current.selectedIndex);
          return;
        }
        return;
      }

      // Question: digits / arrows / Tab / Enter / Esc / typing in notes
      if (pendingQuestionCellId && pendingQuestionRef.current) {
        const pending = pendingQuestionRef.current;
        const current = cells.find(
          (c) => c.id === pendingQuestionCellId && c.kind === 'question',
        );
        if (!current || current.kind !== 'question') return;

        if (key.escape) {
          pending.resolve({ kind: 'dismissed' });
          return;
        }

        // Notes focus: capture typing
        if (current.focusMode === 'notes') {
          if (key.tab) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingQuestionCellId && c.kind === 'question'
                  ? { ...c, focusMode: 'options' }
                  : c,
              ),
            );
            return;
          }
          if (key.return) {
            const otherIdx = current.options.findIndex(
              (o) => o.label === 'Other',
            );
            const selected: number[] =
              current.selectedIndices.length > 0
                ? [...current.selectedIndices]
                : otherIdx >= 0
                  ? [otherIdx]
                  : [];
            const labels = selected
              .map((i) => current.options[i]?.label)
              .filter((s): s is string => Boolean(s));
            pending.resolve({
              kind: 'answered',
              selected: labels,
              custom: current.notes.length > 0 ? current.notes : undefined,
            });
            return;
          }
          if (key.backspace || key.delete) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingQuestionCellId && c.kind === 'question'
                  ? { ...c, notes: c.notes.slice(0, -1) }
                  : c,
              ),
            );
            return;
          }
          if (input && !key.ctrl && !key.meta) {
            setCells((all) =>
              all.map((c) =>
                c.id === pendingQuestionCellId && c.kind === 'question'
                  ? { ...c, notes: c.notes + input }
                  : c,
              ),
            );
          }
          return;
        }

        // Options focus
        if (key.tab) {
          setCells((all) =>
            all.map((c) =>
              c.id === pendingQuestionCellId && c.kind === 'question'
                ? { ...c, focusMode: 'notes' }
                : c,
            ),
          );
          return;
        }
        if (key.upArrow || input === 'k') {
          setCells((all) =>
            all.map((c) =>
              c.id === pendingQuestionCellId && c.kind === 'question'
                ? {
                    ...c,
                    cursor:
                      (c.cursor - 1 + c.options.length) % c.options.length,
                  }
                : c,
            ),
          );
          return;
        }
        if (key.downArrow || input === 'j') {
          setCells((all) =>
            all.map((c) =>
              c.id === pendingQuestionCellId && c.kind === 'question'
                ? {
                    ...c,
                    cursor: (c.cursor + 1) % c.options.length,
                  }
                : c,
            ),
          );
          return;
        }
        const digit = Number.parseInt(input, 10);
        if (
          !Number.isNaN(digit) &&
          digit >= 1 &&
          digit <= current.options.length
        ) {
          const idx = digit - 1;
          if (current.multiSelect) {
            setCells((all) =>
              all.map((c) => {
                if (c.id !== pendingQuestionCellId || c.kind !== 'question')
                  return c;
                const has = c.selectedIndices.includes(idx);
                return {
                  ...c,
                  selectedIndices: has
                    ? c.selectedIndices.filter((i) => i !== idx)
                    : [...c.selectedIndices, idx],
                  cursor: idx,
                };
              }),
            );
          } else {
            // Single-select: pick and shift focus to notes if it's the
            // synthetic "Other" option, otherwise resolve immediately.
            const optionLabel = current.options[idx]?.label;
            if (optionLabel === 'Other') {
              setCells((all) =>
                all.map((c) =>
                  c.id === pendingQuestionCellId && c.kind === 'question'
                    ? {
                        ...c,
                        selectedIndices: [idx],
                        cursor: idx,
                        focusMode: 'notes',
                      }
                    : c,
                ),
              );
            } else if (optionLabel) {
              pending.resolve({ kind: 'answered', selected: [optionLabel] });
            }
          }
          return;
        }
        if (key.return) {
          if (current.multiSelect) {
            const labels = current.selectedIndices
              .map((i) => current.options[i]?.label)
              .filter((s): s is string => Boolean(s));
            if (labels.length === 0) return;
            pending.resolve({ kind: 'answered', selected: labels });
          } else {
            const optionLabel = current.options[current.cursor]?.label;
            if (!optionLabel) return;
            if (optionLabel === 'Other') {
              setCells((all) =>
                all.map((c) =>
                  c.id === pendingQuestionCellId && c.kind === 'question'
                    ? {
                        ...c,
                        selectedIndices: [current.cursor],
                        focusMode: 'notes',
                      }
                    : c,
                ),
              );
              return;
            }
            pending.resolve({ kind: 'answered', selected: [optionLabel] });
          }
        }
      }
    },
    { isActive: view === 'chat' && promptPending },
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
  const headerDot =
    visualMode === 'plan'
      ? glyphs.plan
      : visualMode === 'yolo'
        ? glyphs.yolo
        : '●';

  const planStale = turnsSincePlanUpdate > STALE_PLAN_TURN_THRESHOLD;

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
              planCounts={planCounts}
              planStale={planStale}
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
              : pendingApprovalCellId
                ? 'awaiting approval — press y / a / n'
                : pendingQuestionCellId
                  ? 'awaiting answer — press 1-4 · Tab notes · Esc cancel'
                  : pendingConfirmationCellId
                    ? 'awaiting confirmation — press y / n'
                    : mode === 'plan'
                      ? 'plan: read-only, no edits'
                      : mode === 'yolo'
                        ? 'yolo: approvals off · message juno…'
                        : 'message juno…  (Shift+Tab plan/exec/yolo · ! bash · / commands)'
        }
        isActive={view === 'chat' && !promptPending}
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
          if (promptPending) return;
          if (mode === 'plan') {
            setMode('exec');
          } else if (mode === 'exec') {
            void tryEnterYolo();
          } else {
            setMode('plan');
          }
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
          awaitingUser={
            pendingApprovalCellId
              ? 'approval'
              : pendingQuestionCellId
                ? 'question'
                : pendingConfirmationCellId
                  ? 'confirmation'
                  : null
          }
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
      {upgradeStatus && (
        <Box paddingX={1}>
          <Text color={colors.dim} dimColor>
            {upgradeStatus}
          </Text>
        </Box>
      )}
    </Box>
  );
}
