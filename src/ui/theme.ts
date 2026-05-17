export type ThemeColor =
  | 'white'
  | 'whiteBright'
  | 'cyan'
  | 'cyanBright'
  | 'magenta'
  | 'magentaBright'
  | 'yellow'
  | 'yellowBright'
  | 'red'
  | 'redBright'
  | 'green'
  | 'greenBright'
  | 'gray'
  | 'blue'
  | 'blueBright';

export const colors = {
  user: 'whiteBright' as ThemeColor,
  assistant: 'cyan' as ThemeColor,
  tool: 'yellow' as ThemeColor,
  error: 'red' as ThemeColor,
  plan: 'magenta' as ThemeColor,
  bash: 'yellow' as ThemeColor,
  exec: 'green' as ThemeColor,
  yolo: 'redBright' as ThemeColor,
  warn: 'yellow' as ThemeColor,
  dim: 'gray' as ThemeColor,
  accent: 'cyan' as ThemeColor,
  muted: 'gray' as ThemeColor,
};

export const glyphs = {
  user: '›',
  assistant: '·',
  tool: '⏵',
  plan: '◆',
  bash: '$',
  error: '⚠',
  warning: '△',
  yolo: '!',
  question: '?',
  selector: '›',
  optionPending: '○',
  optionInProgress: '•',
  optionDone: '✓',
  approvalEdit: '→',
  approvalWrite: '→',
  approvalMultiEdit: '↻',
  approvalPatch: '⊹',
  approvalBash: '#',
  bullet: '·',
  arrowDown: '↓',
  arrowUp: '↑',
  spinnerFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  filled: '▓',
  empty: '░',
  cursor: '▎',
  segmentFilled: '▰',
  segmentEmpty: '▱',
  sparkBars: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
};

export function contextColor(percent: number): ThemeColor {
  if (percent >= 90) return colors.error;
  if (percent >= 70) return 'yellow';
  return colors.dim;
}

export function modeAccent(
  mode: 'plan' | 'exec' | 'bash' | 'yolo',
): ThemeColor {
  switch (mode) {
    case 'plan':
      return colors.plan;
    case 'bash':
      return colors.bash;
    case 'yolo':
      return colors.yolo;
    default:
      return colors.exec;
  }
}
