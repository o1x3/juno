import { Box, Text } from 'ink';
import { lexer, type Token, type Tokens } from 'marked';
import type { ReactNode } from 'react';

import { softWrap } from '@/ui/format';
import { colors } from '@/ui/theme';

// AST-driven terminal markdown renderer. Modeled on pi-mono's
// `packages/tui/src/components/markdown.ts` (token-tree walk + width-aware
// indent, no line-by-line regex). Heals open code fences for streaming text
// the same way opencode's `markdown-stream.ts` does.

type RenderCtx = {
  width: number;
  indent: number;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  link?: string;
  color?: string;
};

const HEADING_COLORS = [
  'cyanBright',
  'cyan',
  'magentaBright',
  'magenta',
  'blue',
  'blueBright',
];
const BULLETS = ['•', '◦', '▪'];

function healOpenFence(text: string): string {
  // If there's an odd number of ``` markers, append a closing fence so marked
  // emits a `code` token instead of swallowing the body into a paragraph.
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``;
  return text;
}

function styleSpan(node: ReactNode, ctx: RenderCtx, key: string): ReactNode {
  return (
    <Text
      key={key}
      bold={ctx.bold}
      italic={ctx.italic}
      strikethrough={ctx.strike}
      underline={Boolean(ctx.link)}
      color={ctx.color}
    >
      {node}
    </Text>
  );
}

function renderInline(
  tokens: Token[] | undefined,
  ctx: RenderCtx,
  keyPrefix: string,
): ReactNode[] {
  if (!tokens) return [];
  const out: ReactNode[] = [];
  tokens.forEach((token, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          out.push(...renderInline(t.tokens, ctx, k));
        } else {
          out.push(styleSpan(t.text, ctx, k));
        }
        break;
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        out.push(...renderInline(t.tokens, { ...ctx, bold: true }, k));
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        out.push(...renderInline(t.tokens, { ...ctx, italic: true }, k));
        break;
      }
      case 'del': {
        const t = token as Tokens.Del;
        out.push(...renderInline(t.tokens, { ...ctx, strike: true }, k));
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        out.push(
          <Text key={k} color="yellowBright">
            {`\`${t.text}\``}
          </Text>,
        );
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        out.push(
          ...renderInline(
            t.tokens,
            { ...ctx, color: 'blueBright', link: t.href },
            k,
          ),
        );
        // Append URL in parens so users can copy it (no OSC 8 reliance).
        out.push(
          <Text key={`${k}-href`} color={colors.dim} dimColor>
            {` (${t.href})`}
          </Text>,
        );
        break;
      }
      case 'br': {
        out.push(<Text key={k}>{'\n'}</Text>);
        break;
      }
      case 'escape': {
        const t = token as Tokens.Escape;
        out.push(styleSpan(t.text, ctx, k));
        break;
      }
      case 'image': {
        const t = token as Tokens.Image;
        out.push(
          <Text key={k} color={colors.dim} dimColor>
            {`[image: ${t.text || t.href}]`}
          </Text>,
        );
        break;
      }
      default: {
        const t = token as Tokens.Generic;
        if ('text' in t && typeof t.text === 'string') {
          out.push(styleSpan(t.text, ctx, k));
        }
      }
    }
  });
  return out;
}

function inlineToString(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'codespan':
      case 'escape': {
        out += (token as { text: string }).text;
        break;
      }
      case 'strong':
      case 'em':
      case 'del':
      case 'link': {
        out += inlineToString((token as { tokens?: Token[] }).tokens ?? []);
        break;
      }
      case 'br':
        out += ' ';
        break;
      default:
        if ('text' in (token as Record<string, unknown>)) {
          out += String((token as { text: unknown }).text ?? '');
        }
    }
  }
  return out;
}

function renderHeading(
  token: Tokens.Heading,
  width: number,
  key: string,
): ReactNode {
  const color =
    HEADING_COLORS[Math.min(token.depth, HEADING_COLORS.length) - 1] ?? 'white';
  const prefix = token.depth >= 3 ? `${'#'.repeat(token.depth)} ` : '';
  const text = inlineToString(token.tokens);
  const rendered = `${prefix}${text}`;
  const wrapped = softWrap(rendered, width);
  return (
    <Box
      key={key}
      flexDirection="column"
      marginBottom={token.depth <= 2 ? 1 : 0}
    >
      {wrapped.map((line, i) => (
        <Text key={i} color={color} bold underline={token.depth === 1}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

function renderCodeBlock(
  token: Tokens.Code,
  _width: number,
  key: string,
): ReactNode {
  const lang = (token.lang ?? '').trim();
  const fence = lang ? `\`\`\`${lang}` : '```';
  const lines = token.text.split('\n');
  return (
    <Box key={key} flexDirection="column" marginLeft={2} marginY={0}>
      <Text color={colors.dim} dimColor>
        {fence}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color="cyanBright">
          {`  ${line}`}
        </Text>
      ))}
      <Text color={colors.dim} dimColor>
        {'```'}
      </Text>
    </Box>
  );
}

function renderBlockquote(
  token: Tokens.Blockquote,
  ctx: RenderCtx,
  key: string,
): ReactNode {
  const inner = renderTokens(token.tokens, {
    ...ctx,
    width: Math.max(10, ctx.width - 2),
  });
  return (
    <Box key={key} flexDirection="row" marginBottom={1}>
      <Text color={colors.dim}>{'│ '}</Text>
      <Box flexDirection="column">
        <Text italic color={colors.dim}>
          {inner.length === 0 ? ' ' : ''}
        </Text>
        {inner}
      </Box>
    </Box>
  );
}

function renderList(
  token: Tokens.List,
  ctx: RenderCtx,
  key: string,
): ReactNode {
  return (
    <Box key={key} flexDirection="column" marginBottom={1}>
      {token.items.map((item, i) => {
        const startNum = Number(token.start ?? 1) || 1;
        const marker = token.ordered
          ? `${startNum + i}.`
          : (BULLETS[Math.min(ctx.indent, BULLETS.length - 1)] ?? '•');
        const markerWidth = marker.length + 1;
        const itemCtx: RenderCtx = {
          ...ctx,
          width: Math.max(10, ctx.width - markerWidth - 2),
          indent: ctx.indent + 1,
        };
        const checkbox = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
        const inner = renderTokens(item.tokens, itemCtx);
        return (
          <Box key={i} flexDirection="row">
            <Text color={colors.accent}>{`${marker} `}</Text>
            {checkbox && (
              <Text color={item.checked ? colors.exec : colors.dim}>
                {checkbox}
              </Text>
            )}
            <Box flexDirection="column">{inner}</Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderParagraph(
  token: Tokens.Paragraph,
  ctx: RenderCtx,
  key: string,
): ReactNode {
  // Render inline tokens then soft-wrap the resulting flat text. Inline styles
  // are preserved by emitting one Text per inline token; Ink concatenates them
  // on the same line until they exceed the width — but Ink doesn't reflow
  // inline-styled spans cleanly, so we wrap on the plain string and rely on
  // marked's own structure for short paragraphs. For longer text we render
  // inline tokens inline; long URLs may overflow but legibility wins over
  // perfectly-justified width.
  const inlineNodes = renderInline(
    token.tokens,
    { ...ctx, width: ctx.width },
    key,
  );
  return (
    <Box key={key} flexDirection="row" marginBottom={1}>
      <Text>{inlineNodes}</Text>
    </Box>
  );
}

function renderHr(width: number, key: string): ReactNode {
  const w = Math.max(20, Math.min(width - 2, 80));
  return (
    <Text key={key} color={colors.dim} dimColor>
      {'─'.repeat(w)}
    </Text>
  );
}

function renderTable(
  token: Tokens.Table,
  width: number,
  key: string,
): ReactNode {
  const headers = token.header.map((c) => inlineToString(c.tokens));
  const rows = token.rows.map((r) => r.map((c) => inlineToString(c.tokens)));
  const cols = headers.length;
  const colMaxes = Array.from({ length: cols }, (_, i) =>
    Math.max(headers[i]?.length ?? 0, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const overhead = cols + 1;
  const available = Math.max(20, width - overhead);
  const totalNatural = colMaxes.reduce((a, b) => a + b, 0);
  const scale = totalNatural > available ? available / totalNatural : 1;
  const colWidths = colMaxes.map((m) => Math.max(3, Math.floor(m * scale)));

  const sep = `+${colWidths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const fmtRow = (cells: string[]) =>
    `|${cells
      .map(
        (cell, i) =>
          ` ${(cell ?? '').padEnd(colWidths[i] ?? 0).slice(0, colWidths[i] ?? 0)} `,
      )
      .join('|')}|`;

  return (
    <Box key={key} flexDirection="column" marginBottom={1}>
      <Text color={colors.dim} dimColor>
        {sep}
      </Text>
      <Text bold color="cyanBright">
        {fmtRow(headers)}
      </Text>
      <Text color={colors.dim} dimColor>
        {sep}
      </Text>
      {rows.map((row, i) => (
        <Text key={i}>{fmtRow(row)}</Text>
      ))}
      <Text color={colors.dim} dimColor>
        {sep}
      </Text>
    </Box>
  );
}

function renderTokens(tokens: Token[], ctx: RenderCtx): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, i) => {
    const k = `t-${i}`;
    switch (token.type) {
      case 'space':
        return;
      case 'heading':
        out.push(renderHeading(token as Tokens.Heading, ctx.width, k));
        return;
      case 'paragraph':
        out.push(renderParagraph(token as Tokens.Paragraph, ctx, k));
        return;
      case 'code':
        out.push(renderCodeBlock(token as Tokens.Code, ctx.width, k));
        return;
      case 'list':
        out.push(renderList(token as Tokens.List, ctx, k));
        return;
      case 'blockquote':
        out.push(renderBlockquote(token as Tokens.Blockquote, ctx, k));
        return;
      case 'table':
        out.push(renderTable(token as Tokens.Table, ctx.width, k));
        return;
      case 'hr':
        out.push(renderHr(ctx.width, k));
        return;
      case 'html': {
        // Render raw HTML as dim text. We don't try to parse it.
        const t = token as Tokens.HTML;
        out.push(
          <Text key={k} color={colors.dim} dimColor>
            {t.text}
          </Text>,
        );
        return;
      }
      default: {
        // Fallback: print raw text if available.
        const t = token as Tokens.Generic;
        if ('text' in t && typeof t.text === 'string') {
          const wrapped = softWrap(t.text, ctx.width);
          wrapped.forEach((line, j) => {
            out.push(<Text key={`${k}-${j}`}>{line}</Text>);
          });
        }
      }
    }
  });
  return out;
}

export function renderMarkdown(text: string, width: number): ReactNode[] {
  const safe = healOpenFence(text);
  const tokens = lexer(safe);
  return renderTokens(tokens as Token[], {
    width: Math.max(20, width - 4),
    indent: 0,
  });
}
