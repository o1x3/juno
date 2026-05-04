import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';

import { resolveAuthSummary, startOrResumeChat } from '@/core/chat-service';
import type {
  AgentConfig,
  AuthMode,
  ModelFallback,
  ToolCall,
  ToolResult,
} from '@/types';

type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; text: string }
  | { id: string; kind: 'error'; text: string };

type ChatAppProps = {
  config: AgentConfig;
  initialPrompt?: string;
  sessionId?: string;
};

function formatErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function authModeLabel(mode: AuthMode): string {
  switch (mode) {
    case 'api-key':
      return 'api-key';
    case 'oauth-api-key':
      return 'oauth(api-key)';
    case 'oauth-codex':
      return 'oauth(chatgpt)';
    case 'none':
      return 'none';
  }
}

function modelLabel(active: string, fallback?: ModelFallback): string {
  if (!fallback) return active;
  const tag = fallback.source === 'static' ? ' offline-fallback' : '';
  return `${active} (was ${fallback.from}${tag})`;
}

export function ChatApp({ config, initialPrompt, sessionId }: ChatAppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(initialPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(sessionId ?? 'new');
  const [streamingText, setStreamingText] = useState('');
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [authMode, setAuthMode] = useState<AuthMode>('none');
  const [activeModel, setActiveModel] = useState<string>(config.model);
  const [modelFallback, setModelFallback] = useState<ModelFallback | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    void resolveAuthSummary(config).then((summary) => {
      if (cancelled) return;
      setAuthMode(summary.authMode);
      setActiveModel(summary.activeModel);
      setModelFallback(summary.modelFallback);
    });
    return () => {
      cancelled = true;
    };
  }, [config]);

  async function submit(prompt: string) {
    if (!prompt.trim() || busy) {
      return;
    }

    setBusy(true);
    setStreamingText('');
    setItems((current) => [
      ...current,
      { id: crypto.randomUUID(), kind: 'user', text: prompt },
    ]);
    try {
      const response = await startOrResumeChat({
        config,
        prompt,
        sessionId: activeSessionId === 'new' ? undefined : activeSessionId,
        onTextDelta: (delta) => setStreamingText((current) => current + delta),
        onToolCall: (call: ToolCall) =>
          setItems((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              kind: 'tool',
              text: `Calling ${call.toolName}`,
            },
          ]),
        onToolResult: (result: ToolResult) =>
          setItems((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              kind: 'tool',
              text: `${result.toolName} ${result.isError ? 'failed' : 'completed'}`,
            },
          ]),
      });
      setActiveSessionId(response.sessionId);
      setAuthMode(response.result.authMode);
      setActiveModel(response.result.activeModel);
      setModelFallback(response.result.modelFallback);
      setItems((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          kind: 'assistant',
          text: response.result.assistantText || streamingText,
        },
      ]);
    } catch (error) {
      setItems((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          kind: 'error',
          text: formatErrorText(error),
        },
      ]);
    } finally {
      setBusy(false);
      setInput('');
      setStreamingText('');
    }
  }

  const headerColor = modelFallback ? 'yellow' : 'green';

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text color={headerColor}>
          auth={authModeLabel(authMode)} model=
          {modelLabel(activeModel, modelFallback)} session={activeSessionId}{' '}
          cwd=
          {config.cwd}
        </Text>
      </Box>
      <Static items={items}>
        {(item) => (
          <Text
            key={item.id}
            color={
              item.kind === 'assistant'
                ? 'cyan'
                : item.kind === 'tool'
                  ? 'yellow'
                  : item.kind === 'error'
                    ? 'red'
                    : 'white'
            }
          >
            {item.kind === 'assistant'
              ? 'assistant'
              : item.kind === 'tool'
                ? 'tool'
                : item.kind === 'error'
                  ? 'error'
                  : 'you'}
            : {item.text}
          </Text>
        )}
      </Static>
      {busy ? (
        <Text color="cyan">assistant: {streamingText || '...'}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text color="green">{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => {
            if (value === '/exit') {
              exit();
              return;
            }
            void submit(value);
          }}
        />
      </Box>
    </Box>
  );
}
