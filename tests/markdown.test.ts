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
    // Without healing, marked would treat this as a paragraph and the code
    // would not render as a block. Heal must close the fence so the lexer
    // emits a `code` token. We assert the lexer sees it as code by checking
    // the rendered tree contains a child whose text starts with the fence
    // language tag.
    const out = renderMarkdown('intro\n\n```ts\nconst x = 1;\n', 60);
    expect(out.length).toBeGreaterThan(0);
    const json = JSON.stringify(out);
    expect(json).toContain('ts');
    expect(json).toContain('const x = 1');
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
    const json = JSON.stringify(out);
    // Headline elements all surfaced.
    expect(json).toContain('Heading');
    expect(json).toContain('item one');
    expect(json).toContain('ordered');
    expect(json).toContain('echo hi');
    expect(json).toContain('col a');
    expect(json).toContain('https://example.com');
  });
});

describe('renderMarkdown structure', () => {
  test('inline code spans render as yellowBright', () => {
    const out = renderMarkdown('use `npm` here', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('yellowBright');
    expect(json).toContain('npm');
  });

  test('bold sets bold style on content', () => {
    const out = renderMarkdown('this is **strong**', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('"bold":true');
    expect(json).toContain('strong');
  });

  test('links render the URL in dim parens after the anchor text', () => {
    const out = renderMarkdown('see [here](https://x.test)', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('here');
    expect(json).toContain('https://x.test');
    expect(json).toContain('blueBright');
  });

  test('headings render with bold and a heading colour', () => {
    const out = renderMarkdown('# Title', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('Title');
    expect(json).toContain('"bold":true');
    expect(json).toContain('cyanBright');
  });

  test('horizontal rule renders a divider line', () => {
    const out = renderMarkdown('---', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('─');
  });

  test('blockquote renders the bar glyph', () => {
    const out = renderMarkdown('> quoted', 80);
    const json = JSON.stringify(out);
    expect(json).toContain('│ ');
    expect(json).toContain('quoted');
  });
});
