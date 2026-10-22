import { expect, it } from 'bun:test';

import { readPullRequest } from './github.ts';
import type { RunGh } from './github.ts';

const ref = { repository: 'acme/app', number: 7 };

const replyWith =
  (view: string, repo: string): RunGh =>
  async (args) => ({ ok: true, value: args[0] === 'pr' ? view : repo });

const mergedView = JSON.stringify({
  state: 'MERGED',
  baseRefName: 'main',
  headRefOid: 'abc',
  mergeCommit: { oid: 'def' },
});

const repoView = JSON.stringify({ defaultBranchRef: { name: 'main' } });

it('reads a merged pull request view', async () => {
  const result = await readPullRequest(replyWith(mergedView, repoView), ref);

  expect(result).toEqual({
    ok: true,
    value: {
      state: 'merged',
      base: 'main',
      head: 'abc',
      mergeCommit: 'def',
      trunk: 'main',
      inTrunk: true,
    },
  });
});

it('refuses output that is not JSON or has an unknown state', async () => {
  const unknown = JSON.stringify({
    state: 'DRAFT',
    baseRefName: 'main',
    headRefOid: 'abc',
    mergeCommit: null,
  });

  expect((await readPullRequest(replyWith('oops', repoView), ref)).ok).toBe(false);
  expect((await readPullRequest(replyWith(unknown, repoView), ref)).ok).toBe(false);
});

it('reads the trunk name and refuses a view without one', async () => {
  const trunk = JSON.stringify({ defaultBranchRef: { name: 'trunk' } });
  const found = await readPullRequest(replyWith(mergedView, trunk), ref);

  expect(found.ok && found.value.trunk).toBe('trunk');
  expect((await readPullRequest(replyWith(mergedView, '{}'), ref)).ok).toBe(false);
});
