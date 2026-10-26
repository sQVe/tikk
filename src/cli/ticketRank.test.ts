import { expect, it } from 'bun:test';

import { parseTicketFile } from '../ticket/ticket.ts';
import type { CliSession, CliTicket } from './cliEffects.ts';
import {
  failureOf,
  makeEffects,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import { ticketRank } from './ticketRank.ts';

const ticketOf = (
  id: string,
  kind: CliTicket['frontMatter']['kind'],
  fields: Partial<CliTicket['frontMatter']> = {},
): CliTicket => {
  const base = makeKindTicket(id, kind);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const run = async (args: string[], tickets: CliTicket[], overrides: Partial<CliSession> = {}) => {
  const fakeSession = makeSession({ tickets, overrides });
  const { effects } = makeEffects({ session: fakeSession });
  const result = await ticketRank({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

const writtenRanks = (texts: string[]): Record<string, number | undefined> => {
  const ranks: Record<string, number | undefined> = {};

  for (const text of texts) {
    const parsed = parseTicketFile(text);

    if (parsed.ok) {
      ranks[parsed.value.frontMatter.title] = parsed.value.frontMatter.rank;
    }
  }

  return ranks;
};

it('refuses without a placement flag and writes nothing', async () => {
  const { fakeSession, result } = await run(['demo-3467'], [ticketOf('demo-3467', 'task')]);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses two placement flags and writes nothing', async () => {
  const tickets = [ticketOf('demo-3467', 'task'), ticketOf('demo-3468', 'task')];

  const { fakeSession, result } = await run(
    ['demo-3467', '--first', '--after', 'demo-3468'],
    tickets,
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses to place a ticket before or after itself', async () => {
  const { fakeSession, result } = await run(
    ['demo-3467', '--before', 'demo-3467'],
    [ticketOf('demo-3467', 'task')],
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a sibling ID that does not exist and writes nothing', async () => {
  const { fakeSession, result } = await run(
    ['demo-3467', '--after', 'demo-9999'],
    [ticketOf('demo-3467', 'task')],
  );

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses an archived ticket and writes nothing', async () => {
  const tickets = [ticketOf('demo-3467', 'task', { archived: '2026-01-01' })];
  const { fakeSession, result } = await run(['demo-3467', '--first'], tickets);

  expect(failureOf(result).code).toBe('invalidArguments');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses when a sibling that must change has a file error and writes nothing', async () => {
  const broken = makeTicket('demo-3468', {
    frontMatter: ticketOf('demo-3468', 'task').frontMatter,
    error: 'bad front matter',
  });

  const tickets = [ticketOf('demo-3467', 'task'), broken];
  const { fakeSession, result } = await run(['demo-3467', '--first'], tickets);

  expect(failureOf(result).code).toBe('parseError');
  expect(fakeSession.writes).toEqual([]);
});

it('writes the ranked ticket and only the siblings whose rank changes', async () => {
  const tickets = [
    ticketOf('demo-3467', 'task', { rank: 2, new: true, title: 'Ranked' }),
    ticketOf('demo-3468', 'task', { rank: 1, title: 'Moved' }),
    ticketOf('demo-3469', 'task', { rank: 3, title: 'Steady' }),
  ];

  const { fakeSession, result } = await run(['demo-3467', '--first'], tickets);
  const ranks = writtenRanks(fakeSession.writes.map((write) => write.text));

  expect(successOf(result).json).toMatchObject({ id: 'demo-3467' });

  expect(fakeSession.writes.map((write) => write.path)).toEqual([
    '/store/demo/demo-3467-slug.md',
    '/store/demo/demo-3468-slug.md',
  ]);

  expect(ranks).toEqual({ Ranked: 1, Moved: 2 });
});

it('names the files already written when a later write fails', async () => {
  const writtenPaths: string[] = [];

  const overrides: Partial<CliSession> = {
    writeTicketFile: (path) => {
      writtenPaths.push(path);

      if (writtenPaths.length === 2) {
        return Promise.resolve({ ok: false, reason: { kind: 'failed', message: 'disk full' } });
      }

      return Promise.resolve({ ok: true, value: { hash: 'new-hash' } });
    },
  };

  const tickets = [ticketOf('demo-3467', 'task'), ticketOf('demo-3468', 'task')];
  const { result } = await run(['demo-3467', '--first'], tickets, overrides);
  const failure = failureOf(result);

  expect(failure.code).toBe('storeError');
  expect(failure.message).toContain(writtenPaths[0] ?? '');
});

it('keeps changedOnDisk when a file changed before its write', async () => {
  const overrides: Partial<CliSession> = {
    writeTicketFile: () =>
      Promise.resolve({ ok: false, reason: { kind: 'changedOnDisk', message: 'changed' } }),
  };

  const tickets = [ticketOf('demo-3467', 'task'), ticketOf('demo-3468', 'task')];
  const { result } = await run(['demo-3467', '--first'], tickets, overrides);

  expect(failureOf(result).code).toBe('changedOnDisk');
});
