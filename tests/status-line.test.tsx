import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';

import { StatusLine } from '@/ui/components/status-line';

const BASE = {
  model: 'gpt-5.4',
  spinnerFrame: 0,
  elapsedMs: 1234,
  contextLimit: 100_000,
  errorCount: 0,
};

describe('StatusLine awaitingUser', () => {
  test('streaming with no pending prompt shows spinner', () => {
    const { lastFrame } = render(
      <StatusLine {...BASE} mode="exec" streaming={true} />,
    );
    expect(lastFrame() ?? '').toContain('streaming');
  });

  test('approval pending swaps spinner for "awaiting approval"', () => {
    const { lastFrame } = render(
      <StatusLine
        {...BASE}
        mode="exec"
        streaming={true}
        awaitingUser="approval"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('awaiting approval');
    expect(frame).not.toContain('streaming');
  });

  test('question pending shows "awaiting answer"', () => {
    const { lastFrame } = render(
      <StatusLine
        {...BASE}
        mode="exec"
        streaming={true}
        awaitingUser="question"
      />,
    );
    expect(lastFrame() ?? '').toContain('awaiting answer');
  });

  test('confirmation pending shows "awaiting confirmation"', () => {
    const { lastFrame } = render(
      <StatusLine
        {...BASE}
        mode="exec"
        streaming={false}
        awaitingUser="confirmation"
      />,
    );
    expect(lastFrame() ?? '').toContain('awaiting confirmation');
  });

  test('yolo mode renders distinct label', () => {
    const { lastFrame } = render(
      <StatusLine {...BASE} mode="yolo" streaming={false} />,
    );
    expect(lastFrame() ?? '').toContain('yolo');
  });
});
