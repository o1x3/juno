import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import type { ConfigFile } from '@/core/config';
import { colors } from '@/ui/theme';

export type SettingField =
  | {
      kind: 'text';
      id: string;
      label: string;
      description: string;
      value: string;
    }
  | {
      kind: 'toggle';
      id: string;
      label: string;
      description: string;
      value: boolean;
    }
  | {
      kind: 'enum';
      id: string;
      label: string;
      description: string;
      value: string;
      options: string[];
    }
  | {
      kind: 'number';
      id: string;
      label: string;
      description: string;
      value: number;
    };

export type SettingSection = {
  title: string;
  fields: SettingField[];
};

export type SettingsPageProps = {
  current: ConfigFile;
  draft: ConfigFile;
  onChange: (next: ConfigFile) => void;
  onSave: () => Promise<void>;
  onCancel: () => void;
  authNote: string;
};

function buildSections(draft: ConfigFile): SettingSection[] {
  return [
    {
      title: 'models',
      fields: [
        {
          kind: 'text',
          id: 'execModel',
          label: 'exec model',
          description: 'used for normal chat turns',
          value: draft.execModel ?? '',
        },
        {
          kind: 'text',
          id: 'planModel',
          label: 'plan model',
          description: 'used in plan mode (Shift+Tab)',
          value: draft.planModel ?? '',
        },
        {
          kind: 'text',
          id: 'namingModel',
          label: 'naming model',
          description: 'auto-names new sessions from the first message',
          value: draft.namingModel ?? '',
        },
        {
          kind: 'toggle',
          id: 'autoName',
          label: 'auto-name',
          description: 'on/off for auto-naming sessions',
          value: draft.autoName ?? true,
        },
      ],
    },
    {
      title: 'ui',
      fields: [
        {
          kind: 'enum',
          id: 'ui.statusPane',
          label: 'status pane',
          description: 'visible by default',
          value: draft.ui?.statusPane ?? 'visible',
          options: ['visible', 'hidden'],
        },
        {
          kind: 'enum',
          id: 'ui.theme',
          label: 'theme',
          description: 'auto / dark / light',
          value: draft.ui?.theme ?? 'auto',
          options: ['auto', 'dark', 'light'],
        },
        {
          kind: 'toggle',
          id: 'ui.timestamps',
          label: 'timestamps',
          description: 'show timestamps in transcript',
          value: draft.ui?.timestamps ?? false,
        },
        {
          kind: 'text',
          id: 'ui.statusPaneShortcut',
          label: 'pane shortcut',
          description: 'keybind to toggle status pane',
          value: draft.ui?.statusPaneShortcut ?? 'ctrl+g',
        },
      ],
    },
    {
      title: 'behavior',
      fields: [
        {
          kind: 'number',
          id: 'maxSteps',
          label: 'max tool steps',
          description: 'agent loop step cap',
          value: draft.maxSteps ?? 12,
        },
        {
          kind: 'number',
          id: 'toolOutputLimit',
          label: 'tool out limit',
          description: 'bytes per tool output',
          value: draft.toolOutputLimit ?? 12000,
        },
        {
          kind: 'number',
          id: 'bashTimeoutMs',
          label: 'bash timeout',
          description: 'ms before agent Bash kill',
          value: draft.bashTimeoutMs ?? 15000,
        },
      ],
    },
  ];
}

function setField(draft: ConfigFile, id: string, value: unknown): ConfigFile {
  const next = { ...draft };
  if (id.startsWith('ui.')) {
    const key = id.slice('ui.'.length) as keyof NonNullable<ConfigFile['ui']>;
    next.ui = { ...(next.ui ?? {}), [key]: value as never };
    return next;
  }
  return { ...next, [id]: value } as ConfigFile;
}

export function SettingsPage(props: SettingsPageProps) {
  const sections = buildSections(props.draft);
  const flat = sections.flatMap((section, sIdx) =>
    section.fields.map((field, fIdx) => ({ section, field, sIdx, fIdx })),
  );
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useInput((input, key) => {
    if (editingId) {
      if (key.escape) {
        setEditingId(null);
        setEditing('');
        return;
      }
      if (key.return) {
        const field = flat[cursor]?.field;
        if (!field) return;
        let value: unknown = editing.trim();
        if (field.kind === 'number') {
          const n = Number.parseInt(editing, 10);
          if (!Number.isFinite(n) || n <= 0) {
            setError('positive integer required');
            return;
          }
          value = n;
        }
        if ((value as string) === '') value = undefined;
        const next = setField(props.draft, field.id, value);
        props.onChange(next);
        setEditingId(null);
        setEditing('');
        setError(null);
        return;
      }
      if (key.backspace) {
        setEditing((e) => e.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setEditing((e) => e + input);
      }
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.ctrl && input === 's') {
      setSaving(true);
      void props
        .onSave()
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setSaving(false));
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(flat.length - 1, c + 1));
      return;
    }
    if (input === ' ') {
      const field = flat[cursor]?.field;
      if (field?.kind === 'toggle') {
        const next = setField(props.draft, field.id, !field.value);
        props.onChange(next);
      }
      return;
    }
    if (key.return) {
      const field = flat[cursor]?.field;
      if (!field) return;
      if (field.kind === 'toggle') {
        const next = setField(props.draft, field.id, !field.value);
        props.onChange(next);
        return;
      }
      if (field.kind === 'enum') {
        const idx = field.options.indexOf(field.value);
        const nextValue =
          field.options[(idx + 1) % field.options.length] ?? field.value;
        const next = setField(props.draft, field.id, nextValue);
        props.onChange(next);
        return;
      }
      setEditingId(field.id);
      setEditing(
        field.kind === 'number'
          ? String(field.value)
          : String(field.value ?? ''),
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.accent} bold>
          juno · settings
        </Text>
        <Text color={colors.dim}>
          {'    esc back · ⌃S save · ⏎ edit / toggle'}
        </Text>
      </Box>
      {sections.map((section) => (
        <Box
          key={section.title}
          flexDirection="column"
          borderStyle="round"
          borderColor={colors.dim}
          paddingX={1}
          marginTop={1}
        >
          <Text color={colors.accent}>{section.title}</Text>
          {section.fields.map((field) => {
            const idxInFlat = flat.findIndex((f) => f.field.id === field.id);
            const isCursor = idxInFlat === cursor;
            const valueDisplay =
              field.kind === 'toggle'
                ? field.value
                  ? 'on'
                  : 'off'
                : field.kind === 'number'
                  ? String(field.value)
                  : String(field.value ?? '');
            const displayValue =
              editingId === field.id ? `${editing}_` : valueDisplay;
            return (
              <Box key={field.id} flexDirection="row">
                <Text color={isCursor ? colors.accent : colors.dim}>
                  {isCursor ? '▸ ' : '  '}
                </Text>
                <Text color={isCursor ? 'whiteBright' : 'white'}>
                  {field.label.padEnd(18)}
                </Text>
                <Text color={editingId === field.id ? colors.accent : 'white'}>
                  {displayValue.padEnd(20)}
                </Text>
                <Text color={colors.dim} dimColor>
                  {field.description}
                </Text>
              </Box>
            );
          })}
        </Box>
      ))}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.dim}
        paddingX={1}
        marginTop={1}
      >
        <Text color={colors.accent}>auth</Text>
        <Text color={colors.dim} dimColor>
          {props.authNote}
        </Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={colors.error}>{error}</Text>
        </Box>
      )}
      {saving && (
        <Box marginTop={1}>
          <Text color={colors.accent}>saving…</Text>
        </Box>
      )}
    </Box>
  );
}
