import { expect, it } from 'bun:test';

import { readPullRequest } from './github.ts';
import type { RunGh } from './github.ts';

const ref = { repository: 'acme/app', number: 7 };
const signal = new AbortController().signal;

const replyWith =
  (view: string, repo: string): RunGh =>
  async (args) => {
    const replies: Record<string, string> = { pr: view, repo, api: 'ahead\n' };

    return { ok: true, value: replies[args[0] ?? ''] ?? '' };
  };

const mergedView = JSON.stringify({
  state: 'MERGED',
  baseRefName: 'main',
  headRefOid: 'abc',
  mergeCommit: { oid: 'def' },
});

const repoView = JSON.stringify({ defaultBranchRef: { name: 'main' } });

it('reads a merged pull request view', async () => {
  const result = await readPullRequest(replyWith(mergedView, repoView), ref, signal);

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

  expect((await readPullRequest(replyWith('oops', repoView), ref, signal)).ok).toBe(false);
  expect((await readPullRequest(replyWith(unknown, repoView), ref, signal)).ok).toBe(false);
});

it('reads the trunk name and refuses a view without one', async () => {
  const trunk = JSON.stringify({ defaultBranchRef: { name: 'trunk' } });
  const found = await readPullRequest(replyWith(mergedView, trunk), ref, signal);

  expect(found.ok && found.value.trunk).toBe('trunk');
  expect((await readPullRequest(replyWith(mergedView, '{}'), ref, signal)).ok).toBe(false);
});

it('refuses a compare status GitHub does not return', async () => {
  const releaseView = JSON.stringify({
    state: 'MERGED',
    baseRefName: 'release',
    headRefOid: 'abc',
    mergeCommit: { oid: 'def' },
  });

  const runGh: RunGh = async (args) => {
    const replies: Record<string, string> = { pr: releaseView, repo: repoView, api: 'Not Found\n' };

    return { ok: true, value: replies[args[0] ?? ''] ?? '' };
  };

  const result = await readPullRequest(runGh, ref, signal);

  expect(result.ok).toBe(false);
});
