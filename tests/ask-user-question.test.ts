import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type {
  QuestionRequest,
  QuestionResponse,
  ToolContext,
  ToolSpec,
} from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

type Overrides = Partial<
  Pick<ToolContext, 'requestApproval' | 'requestUserAnswer'>
>;

function makeCtx(overrides: Overrides = {}): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 1000,
    readLineLimit: 50,
    bashTimeoutMs: 1000,
    sessionsDir: join(workspace, 'sessions'),
    sessionId: 's-test',
    ...overrides,
  };
}

function getTool(ctx: ToolContext, name: 'AskUserQuestion'): ToolSpec {
  const tool = createBuiltinTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} tool missing`);
  return tool;
}

describe('AskUserQuestion', () => {
  test('returns answer when the user picks an option', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const seen: QuestionRequest[] = [];
    const ctx = makeCtx({
      requestUserAnswer: async (req) => {
        seen.push(req);
        return { kind: 'answered', selected: ['Yes'] };
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        question: 'Proceed?',
        header: 'Confirm',
        options: [
          { label: 'Yes', description: 'go' },
          { label: 'No', description: 'stop' },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toEqual({ answers: ['Yes'] });
    expect(seen[0]?.question).toBe('Proceed?');
    expect(seen[0]?.header).toBe('Confirm');
    expect(seen[0]?.options).toEqual([
      { label: 'Yes', description: 'go' },
      { label: 'No', description: 'stop' },
    ]);
    expect(typeof seen[0]?.questionId).toBe('string');
  });

  test('attaches custom text when present', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx({
      requestUserAnswer: async () => ({
        kind: 'answered',
        selected: ['Other'],
        custom: 'a custom answer',
      }),
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        question: 'Pick',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      ctx,
    );

    expect(result.output).toEqual({
      answers: ['Other'],
      custom: 'a custom answer',
    });
  });

  test('errors when the user dismisses', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx({
      requestUserAnswer: async () => ({ kind: 'dismissed' }),
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        question: 'q?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('dismissed');
  });

  test('errors when the callback is not wired', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx(); // no callback
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        question: 'q?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('not wired');
  });

  test('schema rejects fewer than 2 options', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx({
      requestUserAnswer: async () => ({ kind: 'answered', selected: ['x'] }),
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const parsed = tool.inputSchema.safeParse({
      question: 'q?',
      options: [{ label: 'only-one' }],
    });
    expect(parsed.success).toBe(false);
  });

  test('schema rejects more than 4 options', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx({
      requestUserAnswer: async () => ({ kind: 'answered', selected: ['x'] }),
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const parsed = tool.inputSchema.safeParse({
      question: 'q?',
      options: [
        { label: 'a' },
        { label: 'b' },
        { label: 'c' },
        { label: 'd' },
        { label: 'e' },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('passes multiSelect/allowCustom through to the callback', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const seen: QuestionRequest[] = [];
    const ctx = makeCtx({
      requestUserAnswer: async (req): Promise<QuestionResponse> => {
        seen.push(req);
        return { kind: 'answered', selected: ['a', 'b'] };
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    await tool.execute(
      {
        toolCallId: 'c1',
        question: 'pick any',
        options: [{ label: 'a' }, { label: 'b' }],
        multiSelect: true,
        allowCustom: false,
      },
      ctx,
    );

    expect(seen[0]?.multiSelect).toBe(true);
    expect(seen[0]?.allowCustom).toBe(false);
  });

  test('allowCustom defaults to true when not provided', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const seen: QuestionRequest[] = [];
    const ctx = makeCtx({
      requestUserAnswer: async (req) => {
        seen.push(req);
        return { kind: 'answered', selected: ['a'] };
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    await tool.execute(
      {
        toolCallId: 'c1',
        question: 'q?',
        options: [{ label: 'a' }, { label: 'b' }],
      },
      ctx,
    );

    expect(seen[0]?.allowCustom).toBe(true);
  });

  test('multi-question form (questions[]) is supported', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const seen: QuestionRequest[] = [];
    const answers: QuestionResponse[] = [
      { kind: 'answered', selected: ['React'] },
      { kind: 'answered', selected: ['Strict'] },
    ];
    let i = 0;
    const ctx = makeCtx({
      requestUserAnswer: async (req): Promise<QuestionResponse> => {
        seen.push(req);
        const a = answers[i] ?? { kind: 'dismissed' };
        i += 1;
        return a;
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        questions: [
          {
            question: 'Which framework?',
            options: [{ label: 'React' }, { label: 'Vue' }],
          },
          {
            question: 'Strict or loose mode?',
            options: [{ label: 'Strict' }, { label: 'Loose' }],
          },
        ],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    const output = result.output as {
      answers: Array<{ question: string; selected: string[] }>;
    };
    expect(output.answers).toHaveLength(2);
    expect(output.answers[0]?.question).toBe('Which framework?');
    expect(output.answers[0]?.selected).toEqual(['React']);
    expect(output.answers[1]?.question).toBe('Strict or loose mode?');
    expect(output.answers[1]?.selected).toEqual(['Strict']);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.progress).toEqual({ current: 1, total: 2 });
    expect(seen[1]?.progress).toEqual({ current: 2, total: 2 });
  });

  test('multi-question dismissal short-circuits with a clear error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    let calls = 0;
    const ctx = makeCtx({
      requestUserAnswer: async (): Promise<QuestionResponse> => {
        calls += 1;
        if (calls === 1) return { kind: 'answered', selected: ['x'] };
        return { kind: 'dismissed' };
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const result = await tool.execute(
      {
        toolCallId: 'c1',
        questions: [
          {
            question: 'first',
            options: [{ label: 'x' }, { label: 'y' }],
          },
          {
            question: 'second',
            options: [{ label: 'a' }, { label: 'b' }],
          },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('dismissed question 2 of 2');
  });

  test('multi-question rejects more than 3 questions', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const ctx = makeCtx({
      requestUserAnswer: async () => ({ kind: 'answered', selected: ['x'] }),
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    const parsed = tool.inputSchema.safeParse({
      questions: [
        { question: 'a', options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'b', options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'c', options: [{ label: 'x' }, { label: 'y' }] },
        { question: 'd', options: [{ label: 'x' }, { label: 'y' }] },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('isSecret is forwarded to the callback', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-q-'));
    const seen: QuestionRequest[] = [];
    const ctx = makeCtx({
      requestUserAnswer: async (req) => {
        seen.push(req);
        return { kind: 'answered', selected: ['Other'], custom: 'hunter2' };
      },
    });
    const tool = getTool(ctx, 'AskUserQuestion');

    await tool.execute(
      {
        toolCallId: 'c1',
        question: 'API key?',
        options: [{ label: 'Skip' }, { label: 'Other' }],
        isSecret: true,
      },
      ctx,
    );

    expect(seen[0]?.isSecret).toBe(true);
  });
});
