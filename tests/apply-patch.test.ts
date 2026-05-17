import { describe, expect, test } from 'bun:test';

import {
  ApplyPatchError,
  deriveUpdatedContents,
  parsePatch,
  seekSequence,
} from '@/core/apply-patch';

describe('parsePatch', () => {
  test('rejects a patch missing the begin marker', () => {
    expect(() => parsePatch('bad')).toThrow(
      "The first line of the patch must be '*** Begin Patch'",
    );
  });

  test('rejects a patch missing the end marker', () => {
    expect(() => parsePatch('*** Begin Patch\nbad')).toThrow(
      "The last line of the patch must be '*** End Patch'",
    );
  });

  test('tolerates whitespace around the markers', () => {
    const hunks = parsePatch(
      '*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch',
    );
    expect(hunks).toEqual([{ kind: 'add', path: 'foo', contents: 'hi\n' }]);
  });

  test('empty patch yields no hunks', () => {
    expect(parsePatch('*** Begin Patch\n*** End Patch')).toEqual([]);
  });

  test('an empty update hunk is an error', () => {
    expect(() =>
      parsePatch('*** Begin Patch\n*** Update File: test.py\n*** End Patch'),
    ).toThrow("Update file hunk for path 'test.py' is empty");
  });

  test('combined add/delete/update+move patch (codex parser.rs parity)', () => {
    const hunks = parsePatch(
      [
        '*** Begin Patch',
        '*** Add File: path/add.py',
        '+abc',
        '+def',
        '*** Delete File: path/delete.py',
        '*** Update File: path/update.py',
        '*** Move to: path/update2.py',
        '@@ def f():',
        '-    pass',
        '+    return 123',
        '*** End Patch',
      ].join('\n'),
    );
    expect(hunks).toEqual([
      { kind: 'add', path: 'path/add.py', contents: 'abc\ndef\n' },
      { kind: 'delete', path: 'path/delete.py' },
      {
        kind: 'update',
        path: 'path/update.py',
        movePath: 'path/update2.py',
        chunks: [
          {
            changeContext: 'def f():',
            oldLines: ['    pass'],
            newLines: ['    return 123'],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test('update hunk followed by another hunk', () => {
    const hunks = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: file.py',
        '@@',
        '+line',
        '*** Add File: other.py',
        '+content',
        '*** End Patch',
      ].join('\n'),
    );
    expect(hunks).toEqual([
      {
        kind: 'update',
        path: 'file.py',
        movePath: undefined,
        chunks: [
          {
            changeContext: undefined,
            oldLines: [],
            newLines: ['line'],
            isEndOfFile: false,
          },
        ],
      },
      { kind: 'add', path: 'other.py', contents: 'content\n' },
    ]);
  });

  test('update hunk without an explicit @@ header parses', () => {
    const hunks = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: file2.py',
        ' import foo',
        '+bar',
        '*** End Patch',
      ].join('\n'),
    );
    expect(hunks).toEqual([
      {
        kind: 'update',
        path: 'file2.py',
        movePath: undefined,
        chunks: [
          {
            changeContext: undefined,
            oldLines: ['import foo'],
            newLines: ['import foo', 'bar'],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test('lenient: heredoc-wrapped patch is unwrapped', () => {
    const inner = [
      '*** Begin Patch',
      '*** Update File: file2.py',
      ' import foo',
      '+bar',
      '*** End Patch',
    ].join('\n');
    for (const open of ['<<EOF', "<<'EOF'", '<<"EOF"']) {
      const hunks = parsePatch(`${open}\n${inner}\nEOF\n`);
      expect(hunks).toEqual([
        {
          kind: 'update',
          path: 'file2.py',
          movePath: undefined,
          chunks: [
            {
              changeContext: undefined,
              oldLines: ['import foo'],
              newLines: ['import foo', 'bar'],
              isEndOfFile: false,
            },
          ],
        },
      ]);
    }
  });

  test('mismatched heredoc quotes still fail strict boundary check', () => {
    const inner = '*** Begin Patch\n*** Update File: f\n+x\n*** End Patch';
    expect(() => parsePatch(`<<"EOF'\n${inner}\nEOF\n`)).toThrow(
      "The first line of the patch must be '*** Begin Patch'",
    );
  });

  test('invalid hunk header is rejected', () => {
    expect(() => parsePatch('*** Begin Patch\nbad\n*** End Patch')).toThrow(
      'is not a valid hunk header',
    );
  });

  test('end-of-file marker sets isEndOfFile', () => {
    const hunks = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: f',
        '@@',
        '+line',
        '*** End of File',
        '*** End Patch',
      ].join('\n'),
    );
    expect(hunks[0]).toMatchObject({
      kind: 'update',
      chunks: [{ newLines: ['line'], isEndOfFile: true }],
    });
  });
});

describe('seekSequence', () => {
  test('exact match', () => {
    expect(seekSequence(['foo', 'bar', 'baz'], ['bar', 'baz'], 0, false)).toBe(
      1,
    );
  });
  test('rstrip match ignores trailing whitespace', () => {
    expect(seekSequence(['foo   ', 'bar\t\t'], ['foo', 'bar'], 0, false)).toBe(
      0,
    );
  });
  test('trim match ignores leading and trailing whitespace', () => {
    expect(
      seekSequence(['    foo   ', '   bar\t'], ['foo', 'bar'], 0, false),
    ).toBe(0);
  });
  test('unicode-folded match (smart quotes / em dash)', () => {
    expect(
      seekSequence(['const s = “hi” — ok'], ['const s = "hi" - ok'], 0, false),
    ).toBe(0);
  });
  test('pattern longer than input returns undefined', () => {
    expect(seekSequence(['one'], ['too', 'many'], 0, false)).toBeUndefined();
  });
  test('empty pattern is a no-op match at start', () => {
    expect(seekSequence(['a'], [], 3, false)).toBe(3);
  });
  test('eof flag prefers the end of file', () => {
    expect(seekSequence(['x', 'x', 'x'], ['x'], 0, true)).toBe(2);
  });
});

describe('deriveUpdatedContents', () => {
  test('simple in-place replacement', () => {
    const next = deriveUpdatedContents('import foo\nprint(1)\n', 'f.py', [
      {
        changeContext: undefined,
        oldLines: ['print(1)'],
        newLines: ['print(2)'],
        isEndOfFile: false,
      },
    ]);
    expect(next).toBe('import foo\nprint(2)\n');
  });

  test('pure addition appends before trailing newline', () => {
    const next = deriveUpdatedContents('a\nb\n', 'f.txt', [
      {
        changeContext: undefined,
        oldLines: [],
        newLines: ['c'],
        isEndOfFile: false,
      },
    ]);
    expect(next).toBe('a\nb\nc\n');
  });

  test('change_context narrows where the chunk applies', () => {
    const original = 'def a():\n    return 1\n\ndef b():\n    return 1\n';
    const next = deriveUpdatedContents(original, 'f.py', [
      {
        changeContext: 'def b():',
        oldLines: ['    return 1'],
        newLines: ['    return 2'],
        isEndOfFile: false,
      },
    ]);
    expect(next).toBe('def a():\n    return 1\n\ndef b():\n    return 2\n');
  });

  test('missing context is reported clearly', () => {
    expect(() =>
      deriveUpdatedContents('a\n', 'f', [
        {
          changeContext: 'nope',
          oldLines: ['a'],
          newLines: ['b'],
          isEndOfFile: false,
        },
      ]),
    ).toThrow(ApplyPatchError);
  });

  test('unfindable old lines reported clearly', () => {
    expect(() =>
      deriveUpdatedContents('a\n', 'f', [
        {
          changeContext: undefined,
          oldLines: ['zzz'],
          newLines: ['b'],
          isEndOfFile: false,
        },
      ]),
    ).toThrow('Failed to find expected lines in f');
  });

  test('whitespace-tolerant match still applies (seek_sequence rstrip)', () => {
    const next = deriveUpdatedContents('  hello   \nworld\n', 'f', [
      {
        changeContext: undefined,
        oldLines: ['hello'],
        newLines: ['HELLO'],
        isEndOfFile: false,
      },
    ]);
    expect(next).toBe('HELLO\nworld\n');
  });
});
