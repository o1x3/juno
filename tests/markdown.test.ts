import { describe, expect, test } from 'bun:test';
import { lexer } from 'marked';

import { renderMarkdown } from '@/ui/markdown';

// We don't snapshot Ink output (env-dependent). Instead exercise the lexer
// expectations the renderer relies on, plus smoke-test renderMarkdown returns
// a node tree without throwing for representative inputs.

describe('marked lexer assumptions', () => {
  test('parses headings with depth', () => {
    const tokens = lexer('# h1\n## h2\n### h3\n');
    const headings = tokens.filter((t) => t.type === 'heading');
    expect(headings.length).toBe(3);
  });

  test('detects bullet and ordered lists', () => {
    const tokens = lexer('- one\n- two\n\n1. a\n2. b\n');
    const lists = tokens.filter((t) => t.type === 'list');
    expect(lists.length).toBe(2);
  });

  test('parses fenced code with language', () => {
    const tokens = lexer('```ts\nconst x = 1;\n```\n');
    const code = tokens.find((t) => t.type === 'code');
    expect(code).toBeDefined();
    expect((code as { lang?: string }).lang).toBe('ts');
  });

  test('parses inline emphasis and code', () => {
    const tokens = lexer('hello **bold** and `code` and *italic*\n');
    const para = tokens.find((t) => t.type === 'paragraph');
    expect(para).toBeDefined();
  });

  test('parses tables', () => {
    const tokens = lexer('| a | b |\n|---|---|\n| 1 | 2 |\n');
    const table = tokens.find((t) => t.type === 'table');
    expect(table).toBeDefined();
  });
});

describe('renderMarkdown smoke', () => {
  test('returns nodes for paragraph', () => {
    const out = renderMarkdown('hello world', 60);
    expect(out.length).toBeGreaterThan(0);
  });

  test('handles unclosed fence (streaming heal)', () => {
    const out = renderMarkdown('intro\n\n```ts\nconst x = 1;\n', 60);
    expect(out.length).toBeGreaterThan(0);
  });

  test('handles a complex doc without throwing', () => {
    const md = [
      '# Heading',
      '',
      'paragraph with **bold**, *italic*, ~~strike~~ and `code`.',
      '',
      '- item one',
      '- item **two**',
      '  - nested',
      '',
      '1. ordered',
      '2. ordered too',
      '',
      '> a quote with `code` inside',
      '',
      '```bash',
      'echo hi',
      '```',
      '',
      '| col a | col b |',
      '| ----- | ----- |',
      '| 1     | 2     |',
      '',
      '[a link](https://example.com)',
      '',
      '---',
    ].join('\n');
    const out = renderMarkdown(md, 80);
    expect(out.length).toBeGreaterThan(5);
  });
});
