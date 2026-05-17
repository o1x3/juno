import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBuiltinTools } from '@/core/tools';
import type { ToolContext, ToolResult, ToolSpec } from '@/types';

let workspace = '';

afterEach(async () => {
  if (workspace) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function ctx(): ToolContext {
  return {
    cwd: workspace,
    outputLimit: 4000,
    readLineLimit: 100,
    bashTimeoutMs: 1000,
    sessionsDir: workspace,
    sessionId: 'test',
  };
}

function tool(): ToolSpec {
  const t = createBuiltinTools(ctx()).find((x) => x.name === 'view_image');
  if (!t) throw new Error('view_image tool missing');
  return t;
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('view_image tool', () => {
  test('reads a PNG and returns codex-shaped output + image media', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-png-'));
    await writeFile(join(workspace, 'shot.png'), PNG);
    const r: ToolResult = await tool().execute(
      { path: 'shot.png', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const o = r.output as {
      path: string;
      image_url: string;
      detail: string | null;
      mediaType: string;
      bytes: number;
    };
    expect(o.path).toBe('shot.png');
    expect(o.mediaType).toBe('image/png');
    expect(o.detail).toBeNull();
    expect(o.image_url.startsWith('data:image/png;base64,')).toBe(true);
    expect(o.bytes).toBe(PNG.length);
    expect(r.media).toEqual({
      kind: 'image',
      dataUrl: o.image_url,
      mediaType: 'image/png',
      detail: null,
    });
  });

  test('detail=original is preserved', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-orig-'));
    await writeFile(join(workspace, 'a.png'), PNG);
    const r = await tool().execute(
      { path: 'a.png', detail: 'original', toolCallId: '1' },
      ctx(),
    );
    expect((r.output as { detail: string }).detail).toBe('original');
    expect(r.media?.detail).toBe('original');
  });

  test('sniffs jpeg / gif / webp by magic bytes regardless of extension', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-sniff-'));
    await writeFile(join(workspace, 'j.bin'), JPEG);
    await writeFile(join(workspace, 'g.bin'), GIF);
    await writeFile(join(workspace, 'w.bin'), WEBP);
    const t = tool();
    expect(
      (
        (await t.execute({ path: 'j.bin', toolCallId: '1' }, ctx())).output as {
          mediaType: string;
        }
      ).mediaType,
    ).toBe('image/jpeg');
    expect(
      (
        (await t.execute({ path: 'g.bin', toolCallId: '2' }, ctx())).output as {
          mediaType: string;
        }
      ).mediaType,
    ).toBe('image/gif');
    expect(
      (
        (await t.execute({ path: 'w.bin', toolCallId: '3' }, ctx())).output as {
          mediaType: string;
        }
      ).mediaType,
    ).toBe('image/webp');
  });

  test('non-image file is refused', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-txt-'));
    await writeFile(join(workspace, 'notes.txt'), 'just text');
    const r = await tool().execute(
      { path: 'notes.txt', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('not a recognized image');
  });

  test('missing file is a friendly error', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-missing-'));
    const r = await tool().execute(
      { path: 'nope.png', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('unable to locate image');
  });

  test('workspace escape is rejected', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'juno-vi-escape-'));
    const r = await tool().execute(
      { path: '../secret.png', toolCallId: '1' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.output)).toContain('outside workspace root');
  });
});
