import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PATH_BLOCK_END,
  PATH_BLOCK_START,
  performUninstall,
  removePathBlockFromShellRcs,
  stripPathBlock,
} from '@/core/uninstall';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'juno-uninstall-'));
});

describe('stripPathBlock', () => {
  test('returns unchanged when block missing', () => {
    const input = 'export PATH=/usr/bin\n';
    const { next, changed } = stripPathBlock(input);
    expect(changed).toBe(false);
    expect(next).toBe(input);
  });

  test('removes a fenced block and trims one leading newline', () => {
    const input = [
      'alias ll="ls -l"',
      '',
      PATH_BLOCK_START,
      'export PATH="$HOME/.local/bin:$PATH"',
      PATH_BLOCK_END,
      'export FOO=1',
    ].join('\n');
    const { next, changed } = stripPathBlock(input);
    expect(changed).toBe(true);
    expect(next).toContain('alias ll');
    expect(next).toContain('export FOO=1');
    expect(next).not.toContain(PATH_BLOCK_START);
    expect(next).not.toContain(PATH_BLOCK_END);
  });

  test('handles block at end of file', () => {
    const input = `alias ll\n${PATH_BLOCK_START}\nexport PATH=x\n${PATH_BLOCK_END}\n`;
    const { next, changed } = stripPathBlock(input);
    expect(changed).toBe(true);
    // strips one leading newline before the block AND one trailing newline after
    // the closing marker so repeated cycles don't accumulate blank lines.
    expect(next).toBe('alias ll');
  });
});

describe('removePathBlockFromShellRcs', () => {
  test('cleans every rc that contains the block; ignores others', () => {
    const fakeZshenv = join(workspace, '.zshenv');
    const fakeBashrc = join(workspace, '.bashrc');
    const fakeProfile = join(workspace, '.profile');
    writeFileSync(
      fakeZshenv,
      `existing\n${PATH_BLOCK_START}\nfoo\n${PATH_BLOCK_END}\nmore\n`,
    );
    writeFileSync(fakeBashrc, 'nothing-to-clean\n');
    writeFileSync(fakeProfile, `${PATH_BLOCK_START}\nbar\n${PATH_BLOCK_END}\n`);

    const edited = removePathBlockFromShellRcs({
      dryRun: false,
      files: [fakeZshenv, fakeBashrc, fakeProfile],
    });
    expect(edited.sort()).toEqual([fakeZshenv, fakeProfile].sort());
    expect(readFileSync(fakeZshenv, 'utf8')).not.toContain(PATH_BLOCK_START);
    expect(readFileSync(fakeBashrc, 'utf8')).toBe('nothing-to-clean\n');
    expect(readFileSync(fakeProfile, 'utf8')).toBe('');
  });

  test('dry-run reports without modifying', () => {
    const fakeZshenv = join(workspace, '.zshenv');
    const content = `${PATH_BLOCK_START}\nx\n${PATH_BLOCK_END}\n`;
    writeFileSync(fakeZshenv, content);
    const edited = removePathBlockFromShellRcs({
      dryRun: true,
      files: [fakeZshenv],
    });
    expect(edited).toEqual([fakeZshenv]);
    expect(readFileSync(fakeZshenv, 'utf8')).toBe(content);
  });
});

describe('performUninstall', () => {
  test('removes binary, .old, and home dir when --purge', async () => {
    const bin = join(workspace, 'bin', 'juno');
    const old = `${bin}.old`;
    const home = join(workspace, 'home');
    mkdirSync(join(workspace, 'bin'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(bin, 'x');
    writeFileSync(old, 'y');
    writeFileSync(join(home, 'auth.json'), '{}');

    const result = await performUninstall({ execPath: bin, homeDir: home });
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(result.removed.sort()).toEqual([bin, old, home].sort());
  });

  test('keeps home dir when not requested', async () => {
    const bin = join(workspace, 'juno');
    const home = join(workspace, 'keep-me');
    mkdirSync(home, { recursive: true });
    writeFileSync(bin, 'x');
    writeFileSync(join(home, 'config.json'), '{}');

    await performUninstall({ execPath: bin });
    expect(existsSync(bin)).toBe(false);
    expect(existsSync(home)).toBe(true);
  });
});
