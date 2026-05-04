import { Box, Static, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';

import { startOrResumeChat } from '@/core/chat-service';
import type { AgentConfig, ToolCall, ToolResult } from '@/types';

type TranscriptItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; text: string };

type ChatAppProps = {
  config: AgentConfig;
  initialPrompt?: string;
  sessionId?: string;
};

export function ChatApp({ config, initialPrompt, sessionId }: ChatAppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(initialPrompt ?? '');
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(sessionId ?? 'new');
  const [streamingText, setStreamingText] = useState('');
  const [items, setItems] = useState<TranscriptItem[]>([]);

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
          kind: 'tool',
          text: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      setBusy(false);
      setInput('');
      setStreamingText('');
    }
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text>
          model={config.model} session={activeSessionId} cwd={config.cwd}
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
                  : 'white'
            }
          >
            {item.kind === 'assistant'
              ? 'assistant'
              : item.kind === 'tool'
                ? 'tool'
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
