export type SlashCommand = {
  name: string;
  description: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show keybinds and commands' },
  { name: 'settings', description: 'Open settings page' },
  { name: 'sessions', description: 'List recent sessions' },
  { name: 'model', description: 'Switch model for this session' },
  { name: 'clear', description: 'Clear transcript (keep session)' },
  { name: 'rename', description: 'Rename this session' },
  { name: 'diff', description: 'Show git diff (uncommitted)' },
  { name: 'copy', description: 'Copy last assistant message' },
  { name: 'exit', description: 'Quit Juno' },
];

export function filterCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, '').toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const starts = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  if (starts.length > 0) return starts;
  return SLASH_COMMANDS.filter((c) => c.name.includes(q));
}

export function parseSlashInput(text: string): {
  isCommand: boolean;
  name: string;
  args: string;
} {
  if (!text.startsWith('/')) return { isCommand: false, name: '', args: '' };
  const trimmed = text.slice(1);
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { isCommand: true, name: trimmed, args: '' };
  return {
    isCommand: true,
    name: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1),
  };
}
