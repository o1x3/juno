const MIN_CHAT_HEIGHT = 8;
const FIXED_CHROME_ROWS = 8;

export function computeChatHeight(termHeight: number): number {
  return Math.max(MIN_CHAT_HEIGHT, termHeight - FIXED_CHROME_ROWS);
}
