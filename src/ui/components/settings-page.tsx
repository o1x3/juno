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
    {
      title: 'updates',
      fields: [
        {
          kind: 'toggle',
          id: 'autoUpgrade',
          label: 'auto-upgrade',
          description: 'silently install new releases on TUI start',
          value: draft.autoUpgrade ?? true,
        },
        {
          kind: 'toggle',
          id: 'updateCheckEnabled',
          label: 'update check',
          description: 'background check GitHub releases on TUI start',
          value: draft.updateCheckEnabled ?? true,
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
  const [editingText, setEditingText] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useInput((input, key) => {
    if (editingId) {
      if (key.escape) {
        setEditingId(null);
        setEditingText('');
        return;
      }
      if (key.return) {
        const field = flat[cursor]?.field;
        if (!field) return;
        let value: unknown = editingText.trim();
        if (field.kind === 'number') {
          const n = Number.parseInt(editingText, 10);
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
        setEditingText('');
        setError(null);
        return;
      }
      // Mac+Ink+Bun reports plain backspace (\x7f) as `key.delete`, not
      // `key.backspace`. Treat both as backspace; same tradeoff documented
      // for the composer.
      if (key.backspace || key.delete) {
        setEditingText((e) => e.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        // Filter raw control bytes (e.g. stray \x7f) so they aren't
        // appended into the editing buffer.
        if (input.length === 1) {
          const code = input.charCodeAt(0);
          if (code < 0x20 || code === 0x7f) return;
        }
        setEditingText((e) => e + input);
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
    if (key.leftArrow || key.rightArrow) {
      const field = flat[cursor]?.field;
      if (field?.kind === 'enum') {
        const idx = field.options.indexOf(field.value);
        const offset = key.leftArrow ? -1 : 1;
        const nextIdx =
          (idx + offset + field.options.length) % field.options.length;
        const nextValue = field.options[nextIdx] ?? field.value;
        const next = setField(props.draft, field.id, nextValue);
        props.onChange(next);
      } else if (field?.kind === 'toggle') {
        const next = setField(props.draft, field.id, !field.value);
        props.onChange(next);
      }
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
        // Enter on enum: enter free-text mode so the user can type a value
        // outside the enum list (e.g. a custom theme later, or a model name
        // when a field is reused as enum-with-suggestions).
        setEditingId(field.id);
        setEditingText(String(field.value ?? ''));
        return;
      }
      setEditingId(field.id);
      setEditingText(
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
          {
            '    ↑↓ row · ←→ cycle · space toggle · ⏎ edit / type custom · ⌃S save · esc back'
          }
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
            const isEditing = editingId === field.id;
            let valueDisplay: string;
            if (isEditing) {
              valueDisplay = `${editingText}_`;
            } else if (field.kind === 'toggle') {
              valueDisplay = field.value ? '◆ on ' : '  off';
            } else if (field.kind === 'enum') {
              const arrowL = isCursor ? '‹ ' : '  ';
              const arrowR = isCursor ? ' ›' : '  ';
              valueDisplay = `${arrowL}${field.value}${arrowR}`;
            } else if (field.kind === 'number') {
              valueDisplay = String(field.value);
            } else {
              valueDisplay = String(field.value ?? '');
            }
            return (
              <Box key={field.id} flexDirection="row">
                <Text color={isCursor ? colors.accent : colors.dim}>
                  {isCursor ? '▸ ' : '  '}
                </Text>
                <Text color={isCursor ? 'whiteBright' : 'white'}>
                  {field.label.padEnd(18)}
                </Text>
                <Text color={isEditing ? colors.accent : 'white'}>
                  {valueDisplay.padEnd(22)}
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
