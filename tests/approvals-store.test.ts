import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addToolApprovalForever,
  isToolApprovedForever,
  loadApprovalAllowlist,
  saveApprovalAllowlist,
} from '@/core/approvals';

let homeDir = '';

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'juno-approvals-'));
});

afterEach(async () => {
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
    homeDir = '';
  }
});

describe('loadApprovalAllowlist', () => {
  test('returns empty when the file is missing', async () => {
    const store = await loadApprovalAllowlist(homeDir);
    expect(store).toEqual({});
  });

  test('tolerates malformed JSON', async () => {
    await writeFile(join(homeDir, 'approvals.json'), 'not json', 'utf8');
    const store = await loadApprovalAllowlist(homeDir);
    expect(store).toEqual({});
  });

  test('filters non-object / non-array entries', async () => {
    await writeFile(
      join(homeDir, 'approvals.json'),
      JSON.stringify({
        '/foo': ['Write', 'Edit'],
        '/bar': 'not an array',
        '': ['Bash'],
        '/baz': [42, 'Bash', null, 'Edit'],
      }),
      'utf8',
    );
    const store = await loadApprovalAllowlist(homeDir);
    expect(store).toEqual({
      '/foo': ['Write', 'Edit'],
      '/baz': ['Bash', 'Edit'],
    });
  });
});

describe('saveApprovalAllowlist', () => {
  test('round-trips via load', async () => {
    const before = {
      '/Users/x/proj-a': ['Write', 'Edit'] as const,
      '/Users/x/proj-b': ['Bash'] as const,
    };
    await saveApprovalAllowlist(homeDir, before as never);
    const after = await loadApprovalAllowlist(homeDir);
    expect(after).toEqual(before as never);
  });

  test('overwrites existing content', async () => {
    await saveApprovalAllowlist(homeDir, { '/p': ['Write'] } as never);
    await saveApprovalAllowlist(homeDir, { '/p': ['Bash'] } as never);
    const store = await loadApprovalAllowlist(homeDir);
    expect(store).toEqual({ '/p': ['Bash'] } as never);
  });
});

describe('isToolApprovedForever', () => {
  test('false when the project is absent', () => {
    expect(isToolApprovedForever({}, '/p', 'Write')).toBe(false);
  });

  test('false when the tool is not in the project entry', () => {
    expect(isToolApprovedForever({ '/p': ['Edit'] }, '/p', 'Write')).toBe(
      false,
    );
  });

  test('true when the tool is in the project entry', () => {
    expect(
      isToolApprovedForever({ '/p': ['Edit', 'Write'] }, '/p', 'Write'),
    ).toBe(true);
  });
});

describe('addToolApprovalForever', () => {
  test('adds a fresh entry without mutating input', () => {
    const before = {};
    const after = addToolApprovalForever(before, '/p', 'Write');
    expect(after).toEqual({ '/p': ['Write'] });
    expect(before).toEqual({});
  });

  test('appends to an existing project entry', () => {
    const before = { '/p': ['Edit'] as ['Edit'] };
    const after = addToolApprovalForever(before, '/p', 'Write');
    expect(after).toEqual({ '/p': ['Edit', 'Write'] });
    expect(before).toEqual({ '/p': ['Edit'] });
  });

  test('is idempotent for an already-present tool', () => {
    const before = { '/p': ['Edit', 'Write'] as ['Edit', 'Write'] };
    const after = addToolApprovalForever(before, '/p', 'Write');
    expect(after).toBe(before);
  });
});
