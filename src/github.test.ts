import { expect, it } from 'bun:test';

import { parsePullRequestView, parseTrunkName } from './github.ts';

it('reads a merged pull request view', () => {
  const text = JSON.stringify({
    state: 'MERGED',
    baseRefName: 'main',
    headRefOid: 'abc',
    mergeCommit: { oid: 'def' },
  });

  expect(parsePullRequestView(text, 'gh pr view')).toEqual({
    ok: true,
    value: { state: 'merged', base: 'main', head: 'abc', mergeCommit: 'def' },
  });
});

it('refuses output that is not JSON or has an unknown state', () => {
  const unknown = JSON.stringify({
    state: 'DRAFT',
    baseRefName: 'main',
    headRefOid: 'abc',
    mergeCommit: null,
  });

  expect(parsePullRequestView('oops', 'gh pr view').ok).toBe(false);
  expect(parsePullRequestView(unknown, 'gh pr view').ok).toBe(false);
});

it('reads the trunk name and refuses a view without one', () => {
  const text = JSON.stringify({ defaultBranchRef: { name: 'trunk' } });

  expect(parseTrunkName(text, 'gh repo view')).toEqual({ ok: true, value: 'trunk' });
  expect(parseTrunkName('{}', 'gh repo view').ok).toBe(false);
});
