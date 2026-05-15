export type KeyContext =
  | 'composer'
  | 'transcript'
  | 'palette'
  | 'settings'
  | 'global';

export type KeySpec = {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  alt?: boolean;
  key?:
    | 'tab'
    | 'enter'
    | 'escape'
    | 'backspace'
    | 'delete'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'pageUp'
    | 'pageDown';
  input?: string;
};

export type KeybindDef = {
  id: string;
  description: string;
  contexts: KeyContext[];
  bindings: KeySpec[];
};

export const KEYBINDS: KeybindDef[] = [
  {
    id: 'submit',
    description: 'Submit',
    contexts: ['composer'],
    bindings: [{ key: 'enter' }],
  },
  {
    id: 'newline',
    description: 'Newline',
    contexts: ['composer'],
    bindings: [{ ctrl: true, input: 'j' }],
  },
  {
    id: 'mode-toggle',
    description: 'Plan ⇄ exec ⇄ yolo',
    contexts: ['composer'],
    bindings: [{ shift: true, key: 'tab' }],
  },
  {
    id: 'todo-toggle',
    description: 'Expand/collapse latest todo',
    contexts: ['transcript', 'global'],
    bindings: [{ ctrl: true, input: 'p' }],
  },
  {
    id: 'approval-prev',
    description: 'Previous approval option',
    contexts: ['global'],
    bindings: [{ key: 'up' }, { input: 'k' }],
  },
  {
    id: 'approval-next',
    description: 'Next approval option',
    contexts: ['global'],
    bindings: [{ key: 'down' }, { input: 'j' }],
  },
  {
    id: 'approval-confirm',
    description: 'Confirm approval',
    contexts: ['global'],
    bindings: [{ key: 'enter' }],
  },
  {
    id: 'approval-reject',
    description: 'Reject approval',
    contexts: ['global'],
    bindings: [{ key: 'escape' }],
  },
  {
    id: 'question-toggle-focus',
    description: 'Switch options ⇄ notes',
    contexts: ['global'],
    bindings: [{ key: 'tab' }],
  },
  {
    id: 'pane-toggle',
    description: 'Toggle status pane',
    contexts: ['global'],
    bindings: [{ ctrl: true, input: 'g' }],
  },
  {
    id: 'cancel-turn',
    description: 'Cancel turn',
    contexts: ['global'],
    bindings: [{ ctrl: true, input: 'c' }],
  },
  {
    id: 'palette-cancel',
    description: 'Close',
    contexts: ['palette', 'settings'],
    bindings: [{ key: 'escape' }],
  },
  {
    id: 'settings-save',
    description: 'Save & exit',
    contexts: ['settings'],
    bindings: [{ ctrl: true, input: 's' }],
  },
  {
    id: 'scroll-up',
    description: 'Scroll up',
    contexts: ['transcript'],
    bindings: [{ key: 'pageUp' }, { ctrl: true, input: 'b' }],
  },
  {
    id: 'scroll-down',
    description: 'Scroll down',
    contexts: ['transcript'],
    bindings: [{ key: 'pageDown' }, { ctrl: true, input: 'f' }],
  },
  {
    id: 'scroll-home',
    description: 'Top',
    contexts: ['transcript'],
    bindings: [{ key: 'home' }],
  },
  {
    id: 'scroll-end',
    description: 'Bottom',
    contexts: ['transcript'],
    bindings: [{ key: 'end' }],
  },
];

export type InkKey = {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};

function inkKeyMatches(key: KeySpec['key'], inkKey: InkKey): boolean {
  switch (key) {
    case 'tab':
      return Boolean(inkKey.tab);
    case 'enter':
      return Boolean(inkKey.return);
    case 'escape':
      return Boolean(inkKey.escape);
    case 'backspace':
      return Boolean(inkKey.backspace);
    case 'delete':
      return Boolean(inkKey.delete);
    case 'up':
      return Boolean(inkKey.upArrow);
    case 'down':
      return Boolean(inkKey.downArrow);
    case 'left':
      return Boolean(inkKey.leftArrow);
    case 'right':
      return Boolean(inkKey.rightArrow);
    case 'home':
      return Boolean(inkKey.home);
    case 'end':
      return Boolean(inkKey.end);
    case 'pageUp':
      return Boolean(inkKey.pageUp);
    case 'pageDown':
      return Boolean(inkKey.pageDown);
    default:
      return false;
  }
}

export function matchSpec(
  spec: KeySpec,
  input: string,
  inkKey: InkKey,
): boolean {
  if (spec.ctrl && !inkKey.ctrl) return false;
  if (!spec.ctrl && inkKey.ctrl) return false;
  if (spec.shift && !inkKey.shift) return false;
  if (spec.meta && !inkKey.meta) return false;
  if (spec.key !== undefined) return inkKeyMatches(spec.key, inkKey);
  if (spec.input !== undefined) return input === spec.input;
  return false;
}

export function matchKeybind(
  id: string,
  input: string,
  inkKey: InkKey,
): boolean {
  const def = KEYBINDS.find((k) => k.id === id);
  if (!def) return false;
  return def.bindings.some((spec) => matchSpec(spec, input, inkKey));
}

export function describeBinding(spec: KeySpec): string {
  const parts: string[] = [];
  if (spec.ctrl) parts.push('⌃');
  if (spec.shift) parts.push('⇧');
  if (spec.meta) parts.push('⌘');
  if (spec.alt) parts.push('⌥');
  if (spec.key) {
    const map: Record<string, string> = {
      tab: '⇥',
      enter: '⏎',
      escape: '⎋',
      backspace: '⌫',
      delete: '⌦',
      up: '↑',
      down: '↓',
      left: '←',
      right: '→',
      home: 'Home',
      end: 'End',
      pageUp: 'PgUp',
      pageDown: 'PgDn',
    };
    parts.push(map[spec.key] ?? spec.key);
  } else if (spec.input) {
    parts.push(spec.input.toUpperCase());
  }
  return parts.join('');
}
