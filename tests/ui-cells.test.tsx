import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';

import type { DiffPayload } from '@/core/diff';
import type { TranscriptCell } from '@/ui/components/cells';
import {
  ApprovalCell,
  ConfirmationCell,
  QuestionCell,
  TodoCell,
  ToolGroupCell,
} from '@/ui/components/cells';

const WIDTH = 80;

function buildDiff(): DiffPayload {
  return {
    hunks: [
      {
        kind: 'change',
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: 'del', oldLine: 1, text: 'before' },
          { kind: 'add', newLine: 1, text: 'after' },
        ],
      },
    ],
  };
}

describe('TodoCell', () => {
  test('expanded form renders pi-mono glyphs', () => {
    const cell: Extract<TranscriptCell, { kind: 'todo' }> = {
      id: 't1',
      kind: 'todo',
      todos: [
        { id: 'a', content: 'first', status: 'completed' },
        { id: 'b', content: 'second', status: 'in_progress' },
        { id: 'c', content: 'third', status: 'pending' },
      ],
    };
    const { lastFrame } = render(<TodoCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan · 3 items');
    expect(frame).toContain('✓');
    expect(frame).toContain('•');
    expect(frame).toContain('○');
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).toContain('third');
    expect(frame).toContain('1/3 done · 1 active');
  });

  test('collapsed form is a single-line chip', () => {
    const cell: Extract<TranscriptCell, { kind: 'todo' }> = {
      id: 't1',
      kind: 'todo',
      collapsed: true,
      todos: [
        { id: 'a', content: 'first', status: 'completed' },
        { id: 'b', content: 'second', status: 'in_progress' },
        { id: 'c', content: 'third', status: 'pending' },
      ],
    };
    const { lastFrame } = render(<TodoCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1/3 done · 1 active');
    expect(frame).toContain('⌃P expand');
    // body lines should not appear
    expect(frame).not.toContain('first');
    expect(frame).not.toContain('second');
  });

  test('empty plan shows cleared marker', () => {
    const cell: Extract<TranscriptCell, { kind: 'todo' }> = {
      id: 't1',
      kind: 'todo',
      todos: [],
    };
    const { lastFrame } = render(<TodoCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('cleared');
  });
});

describe('ToolGroupCell Task result', () => {
  test('renders the sub-agent badge, description, tool count, and summary', () => {
    const cell: Extract<TranscriptCell, { kind: 'tool-group' }> = {
      id: 'tg1',
      kind: 'tool-group',
      collapsed: false,
      complete: true,
      tools: [
        {
          call: {
            toolCallId: 'c1',
            toolName: 'Task',
            input: {
              subagent_type: 'explore',
              description: 'find the auth flow',
            },
          },
          result: {
            toolCallId: 'c1',
            toolName: 'Task',
            output: {
              task_id: 's.sub-abc',
              agent: 'explore',
              description: 'find the auth flow',
              tool_calls: 5,
              result: 'Auth lives in src/auth/codex.ts and storage.ts.',
            },
          },
          startedAt: 0,
          endedAt: 1200,
        },
      ],
    };
    const { lastFrame } = render(<ToolGroupCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Task');
    expect(frame).toContain('explore: find the auth flow');
    expect(frame).toContain('◇ explore');
    expect(frame).toContain('5 tools');
    expect(frame).toContain('Auth lives in src/auth/codex.ts');
  });
});

describe('ToolGroupCell LSP result', () => {
  test('renders a compact server · operation line', () => {
    const cell: Extract<TranscriptCell, { kind: 'tool-group' }> = {
      id: 'tgl',
      kind: 'tool-group',
      collapsed: false,
      complete: true,
      tools: [
        {
          call: {
            toolCallId: 'l1',
            toolName: 'LSP',
            input: { operation: 'goToDefinition', filePath: 'src/x.ts' },
          },
          result: {
            toolCallId: 'l1',
            toolName: 'LSP',
            output: {
              operation: 'goToDefinition',
              server: 'typescript',
              empty: false,
              result: [{ uri: 'file://x' }],
              text: '[…]',
            },
          },
          startedAt: 0,
          endedAt: 30,
        },
      ],
    };
    const { lastFrame } = render(<ToolGroupCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('LSP');
    expect(frame).toContain('typescript · goToDefinition');
  });
});

describe('ToolGroupCell Skill result', () => {
  test('renders a loaded-skill confirmation line', () => {
    const cell: Extract<TranscriptCell, { kind: 'tool-group' }> = {
      id: 'tgs',
      kind: 'tool-group',
      collapsed: false,
      complete: true,
      tools: [
        {
          call: {
            toolCallId: 's1',
            toolName: 'Skill',
            input: { name: 'pdf-fill' },
          },
          result: {
            toolCallId: 's1',
            toolName: 'Skill',
            output: {
              name: 'pdf-fill',
              dir: '.juno/skills/pdf-fill',
              fileCount: 3,
              content: '<skill_content name="pdf-fill">…</skill_content>',
            },
          },
          startedAt: 0,
          endedAt: 20,
        },
      ],
    };
    const { lastFrame } = render(<ToolGroupCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Skill');
    expect(frame).toContain('loaded skill: pdf-fill');
    expect(frame).toContain('3 resource files');
  });
});

describe('ToolGroupCell view_image result', () => {
  test('renders a compact image line marked as shown to the model', () => {
    const cell: Extract<TranscriptCell, { kind: 'tool-group' }> = {
      id: 'tgi',
      kind: 'tool-group',
      collapsed: false,
      complete: true,
      tools: [
        {
          call: {
            toolCallId: 'i1',
            toolName: 'view_image',
            input: { path: 'design/mock.png' },
          },
          result: {
            toolCallId: 'i1',
            toolName: 'view_image',
            output: {
              path: 'design/mock.png',
              image_url: 'data:image/png;base64,QQ==',
              detail: 'original',
              mediaType: 'image/png',
              bytes: 2048,
            },
            media: {
              kind: 'image',
              dataUrl: 'data:image/png;base64,QQ==',
              mediaType: 'image/png',
              detail: 'original',
            },
          },
          startedAt: 0,
          endedAt: 50,
        },
      ],
    };
    const { lastFrame } = render(<ToolGroupCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('view_image');
    expect(frame).toContain('design/mock.png');
    expect(frame).toContain('image/png');
    expect(frame).toContain('2.0 kB');
    expect(frame).toContain('original');
    expect(frame).toContain('shown to the model');
  });
});

describe('ApprovalCell', () => {
  test('pending Write renders header + path + diff + footer', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a1',
      kind: 'approval',
      toolName: 'Write',
      preview: {
        kind: 'write',
        path: '/tmp/x.txt',
        bytes: 5,
        created: true,
        diff: buildDiff(),
      },
      status: 'pending',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Permission required');
    expect(frame).toContain('Write');
    expect(frame).toContain('x.txt');
    expect(frame).toContain('Approve');
    expect(frame).toContain('Approve always');
    expect(frame).toContain('Reject');
    expect(frame).toContain('(y)');
    expect(frame).toContain('(a)');
    expect(frame).toContain('(n)');
    expect(frame).toContain('awaiting decision');
  });

  test('pending apply_patch lists every file op + per-file diff', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'ap1',
      kind: 'approval',
      toolName: 'apply_patch',
      preview: {
        kind: 'apply-patch',
        files: [
          {
            path: 'src/new.ts',
            op: 'add',
            diff: { ...buildDiff(), created: true },
          },
          { path: 'src/old.ts', op: 'update', diff: buildDiff() },
          { path: 'src/gone.ts', op: 'delete' },
          {
            path: 'src/a.ts',
            op: 'move',
            movePath: 'src/b.ts',
            diff: buildDiff(),
          },
        ],
      },
      status: 'pending',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Permission required');
    expect(frame).toContain('apply_patch · 4 files');
    expect(frame).toContain('add');
    expect(frame).toContain('src/new.ts');
    expect(frame).toContain('update');
    expect(frame).toContain('delete');
    expect(frame).toContain('move');
    expect(frame).toContain('src/a.ts → src/b.ts');
    expect(frame).toContain('Approve');
    expect(frame).toContain('Reject');
  });

  test('pending Bash shows the command instead of a diff', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a2',
      kind: 'approval',
      toolName: 'Bash',
      preview: { kind: 'bash', command: 'rm -rf /tmp/scratch' },
      status: 'pending',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Permission required');
    expect(frame).toContain('rm -rf /tmp/scratch');
  });

  test('approved state shows status badge and hides keystroke hint', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a3',
      kind: 'approval',
      toolName: 'Edit',
      preview: { kind: 'edit', path: '/tmp/y.ts', diff: buildDiff() },
      status: 'approved',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('approved');
    expect(frame).not.toContain('Enter confirm');
  });

  test('rejected state shows rejected status', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a4',
      kind: 'approval',
      toolName: 'Bash',
      preview: { kind: 'bash', command: 'ls' },
      status: 'rejected',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('rejected');
  });

  test('expandDiff toggle changes footer hint and hides "lines hidden"', () => {
    // Build a diff with >40 lines so collapse fires.
    const lines = [];
    for (let i = 1; i <= 50; i += 1) {
      lines.push({ kind: 'del' as const, oldLine: i, text: `old line ${i}` });
      lines.push({ kind: 'add' as const, newLine: i, text: `new line ${i}` });
    }
    const big: DiffPayload = {
      hunks: [
        {
          kind: 'change',
          oldStart: 1,
          oldLines: 50,
          newStart: 1,
          newLines: 50,
          lines,
        },
      ],
    };
    const baseCell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'ax',
      kind: 'approval',
      toolName: 'Edit',
      preview: { kind: 'edit', path: '/tmp/big.ts', diff: big },
      status: 'pending',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const collapsedRender = render(
      <ApprovalCell cell={baseCell} width={WIDTH} />,
    );
    const collapsedFrame = collapsedRender.lastFrame() ?? '';
    expect(collapsedFrame).toContain('lines hidden');
    expect(collapsedFrame).toContain('⌃F expand');

    const expandedRender = render(
      <ApprovalCell cell={{ ...baseCell, expandDiff: true }} width={WIDTH} />,
    );
    const expandedFrame = expandedRender.lastFrame() ?? '';
    expect(expandedFrame).not.toContain('lines hidden (');
    expect(expandedFrame).toContain('⌃F collapse');
  });

  test('feedback focus shows the textarea with prompt hint', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a-fb',
      kind: 'approval',
      toolName: 'Bash',
      preview: { kind: 'bash', command: 'rm -rf /' },
      status: 'pending',
      selectedIndex: 2,
      feedback: 'this is dangerous',
      focusMode: 'feedback',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('reason');
    expect(frame).toContain('this is dangerous');
    expect(frame).toContain('Enter submit');
  });

  test('rejected with a reason shows the reason inline', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a-reason',
      kind: 'approval',
      toolName: 'Bash',
      preview: { kind: 'bash', command: 'rm -rf /' },
      status: 'rejected',
      selectedIndex: 2,
      feedback: '',
      focusMode: 'options',
      rejectionReason: 'too destructive',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('reason: too destructive');
  });

  test('approved_forever state shows the remembered-for-project hint', () => {
    const cell: Extract<TranscriptCell, { kind: 'approval' }> = {
      id: 'a5',
      kind: 'approval',
      toolName: 'Write',
      preview: {
        kind: 'write',
        path: '/tmp/z.txt',
        bytes: 1,
        created: false,
        diff: buildDiff(),
      },
      status: 'approved_forever',
      selectedIndex: 0,
      feedback: '',
      focusMode: 'options',
    };
    const { lastFrame } = render(<ApprovalCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('remembered for this project');
  });
});

describe('QuestionCell', () => {
  test('pending single-select shows options with descriptions', () => {
    const cell: Extract<TranscriptCell, { kind: 'question' }> = {
      id: 'q1',
      kind: 'question',
      questionId: 'qid-1',
      question: 'Which framework do you prefer?',
      header: 'Framework',
      options: [
        { label: 'React', description: 'component model' },
        { label: 'Vue', description: 'progressive framework' },
      ],
      multiSelect: false,
      status: 'pending',
      selectedIndices: [],
      focusMode: 'options',
      notes: '',
      cursor: 0,
    };
    const { lastFrame } = render(<QuestionCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Framework');
    expect(frame).toContain('Which framework do you prefer?');
    expect(frame).toContain('React');
    expect(frame).toContain('Vue');
    expect(frame).toContain('component model');
    expect(frame).toContain('progressive framework');
    expect(frame).toContain('1-4 select');
    expect(frame).toContain('Tab notes');
  });

  test('pending multi-select shows checkboxes and toggle hint', () => {
    const cell: Extract<TranscriptCell, { kind: 'question' }> = {
      id: 'q2',
      kind: 'question',
      questionId: 'qid-2',
      question: 'Pick languages',
      header: 'Langs',
      options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }],
      multiSelect: true,
      status: 'pending',
      selectedIndices: [0, 2],
      focusMode: 'options',
      notes: '',
      cursor: 1,
    };
    const { lastFrame } = render(<QuestionCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[x] TypeScript');
    expect(frame).toContain('[ ] Rust');
    expect(frame).toContain('[x] Go');
    expect(frame).toContain('1-4 toggle');
  });

  test('notes focus renders the inline notes composer', () => {
    const cell: Extract<TranscriptCell, { kind: 'question' }> = {
      id: 'q3',
      kind: 'question',
      questionId: 'qid-3',
      question: 'q?',
      options: [{ label: 'a' }, { label: 'Other' }],
      multiSelect: false,
      status: 'pending',
      selectedIndices: [1],
      focusMode: 'notes',
      notes: 'a free-form answer',
      cursor: 1,
    };
    const { lastFrame } = render(<QuestionCell cell={cell} width={WIDTH} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('notes');
    expect(frame).toContain('a free-form answer');
  });

  test('answered state shows the selected labels', () => {
    const cell: Extract<TranscriptCell, { kind: 'question' }> = {
      id: 'q4',
      kind: 'question',
      questionId: 'qid-4',
      question: 'pick one',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
      status: 'answered',
      answer: { kind: 'answered', selected: ['A'] },
      selectedIndices: [0],
      focusMode: 'options',
      notes: '',
      cursor: 0,
    };
    const { lastFrame } = render(<QuestionCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('answered');
    expect(lastFrame() ?? '').toContain('A');
  });

  test('dismissed state shows the dismissed badge', () => {
    const cell: Extract<TranscriptCell, { kind: 'question' }> = {
      id: 'q5',
      kind: 'question',
      questionId: 'qid-5',
      question: 'q?',
      options: [{ label: 'A' }, { label: 'B' }],
      multiSelect: false,
      status: 'dismissed',
      answer: { kind: 'dismissed' },
      selectedIndices: [],
      focusMode: 'options',
      notes: '',
      cursor: 0,
    };
    const { lastFrame } = render(<QuestionCell cell={cell} width={WIDTH} />);
    expect(lastFrame() ?? '').toContain('dismissed');
  });
});

describe('ConfirmationCell', () => {
  test('pending state shows y/n and waiting badge', () => {
    const cell: Extract<TranscriptCell, { kind: 'confirmation' }> = {
      id: 'cf1',
      kind: 'confirmation',
      title: 'yolo mode',
      body: 'In yolo mode all approvals are skipped.',
      status: 'pending',
    };
    const { lastFrame } = render(
      <ConfirmationCell cell={cell} width={WIDTH} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('yolo mode');
    expect(frame).toContain('all approvals are skipped');
    expect(frame).toContain('confirm and enter yolo');
    expect(frame).toContain('cancel and stay in exec');
    expect(frame).toContain('awaiting decision');
  });

  test('confirmed state hides the keystroke prompts', () => {
    const cell: Extract<TranscriptCell, { kind: 'confirmation' }> = {
      id: 'cf2',
      kind: 'confirmation',
      title: 'yolo mode',
      body: 'In yolo mode all approvals are skipped.',
      status: 'confirmed',
    };
    const { lastFrame } = render(
      <ConfirmationCell cell={cell} width={WIDTH} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('confirmed');
    expect(frame).not.toContain('confirm and enter yolo');
  });

  test('cancelled state hides the keystroke prompts', () => {
    const cell: Extract<TranscriptCell, { kind: 'confirmation' }> = {
      id: 'cf3',
      kind: 'confirmation',
      title: 'yolo mode',
      body: 'In yolo mode all approvals are skipped.',
      status: 'cancelled',
    };
    const { lastFrame } = render(
      <ConfirmationCell cell={cell} width={WIDTH} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('cancelled');
    expect(frame).not.toContain('confirm and enter yolo');
  });
});
