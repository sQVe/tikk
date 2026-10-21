import { expect, it } from 'bun:test';

import { commitStore } from './syncCommit.ts';
import { gitFailure, gitOutput, makeSync } from './syncHarness.ts';

const root = '/store';
const now = 100_000;
const validTicket = '---\nkind: task\ntitle: Valid\nproject: demo\nstatus: open\n---\nBody\n';

const listing =
  (deleted: string[], changed: string[]) =>
  (args: string[]): ReturnType<typeof gitOutput> | undefined => {
    if (args.includes('--deleted')) {
      return gitOutput(deleted.map((path) => `${path}\0`).join(''));
    }

    if (args.includes('--others')) {
      return gitOutput(changed.map((path) => `${path}\0`).join(''));
    }

    return undefined;
  };

const addedPaths = (args: string[] | undefined): string[] =>
  args === undefined ? [] : args.slice(args.indexOf('--') + 1);

it('stages facts, settled tickets, and deletions, and lists the rest as pending', async () => {
  const fake = makeSync({
    now,
    git: listing(
      ['tickets/demo/gone.md'],
      [
        'tickets/demo/gone.md',
        'facts/laptop/2026-10.jsonl',
        'tikk.json',
        'tickets/demo/settled.md',
        'tickets/demo/fresh.md',
        'tickets/demo/broken.md',
        'tickets/demo/vanished.md',
      ],
    ),
    files: {
      '/store/tickets/demo/settled.md': { text: validTicket, mtimeMs: now - 2000 },
      '/store/tickets/demo/fresh.md': { text: validTicket, mtimeMs: now - 1999 },
      '/store/tickets/demo/broken.md': { text: 'no front matter', mtimeMs: now - 5000 },
    },
  });

  const result = await commitStore(fake.functions, root);
  const add = fake.gitCalls.find((call) => call.args.includes('add'));

  expect(result).toEqual({
    ok: true,
    value: {
      committed: true,
      pending: ['tickets/demo/fresh.md', 'tickets/demo/broken.md', 'tickets/demo/vanished.md'],
    },
  });

  expect(addedPaths(add?.args).toSorted()).toEqual(
    [
      'facts/laptop/2026-10.jsonl',
      'tickets/demo/gone.md',
      'tickets/demo/settled.md',
      'tikk.json',
    ].toSorted(),
  );
});

it('makes no commit when only pending tickets changed', async () => {
  const fake = makeSync({
    now,
    git: listing([], ['tickets/demo/fresh.md']),
    files: { '/store/tickets/demo/fresh.md': { text: validTicket, mtimeMs: now } },
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({
    ok: true,
    value: { committed: false, pending: ['tickets/demo/fresh.md'] },
  });

  expect(fake.gitCalls.some((call) => call.args.includes('add'))).toBe(false);
  expect(fake.gitCalls.some((call) => call.args.includes('commit'))).toBe(false);
});

it('fails with the git message when listing changes fails', async () => {
  const fake = makeSync({
    git: (args) => (args.includes('ls-files') ? gitFailure('not a repository') : undefined),
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'not a repository' } });
  expect(fake.gitCalls.some((call) => call.args.includes('commit'))).toBe(false);
});

it('fails with the git message when the commit fails', async () => {
  const fake = makeSync({
    git: (args) =>
      args.includes('commit') ? gitFailure('cannot sign') : listing([], ['tikk.json'])(args),
  });

  const result = await commitStore(fake.functions, root);

  expect(result).toEqual({ ok: false, reason: { kind: 'failed', message: 'cannot sign' } });
});
