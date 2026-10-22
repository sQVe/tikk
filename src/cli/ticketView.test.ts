import { expect, it } from 'bun:test';

import { makeSession, makeTicket, projectNameOf, ticketIdOf } from './cliHarness.ts';
import {
  findTicket,
  showAfterRefresh,
  storeFailure,
  ticketText,
  ticketView,
} from './ticketView.ts';

const full = makeTicket('demo-3467', {
  error: 'Stale.',
  frontMatter: {
    kind: 'issue',
    title: 'Full',
    project: projectNameOf('demo'),
    parent: ticketIdOf('demo-3468'),
    rank: 2,
    blockedBy: [ticketIdOf('demo-3469')],
    discoveredFrom: [ticketIdOf('demo-3473')],
    related: [ticketIdOf('demo-3474')],
    status: 'draft',
    archived: '2026-01-01',
  },
});

it('maps every ticket field into the view', () => {
  expect(ticketView(full, false)).toEqual({
    id: 'demo-3467',
    path: full.path,
    hash: full.hash,
    kind: 'issue',
    title: 'Full',
    project: 'demo',
    parent: 'demo-3468',
    rank: 2,
    blockedBy: ['demo-3469'],
    discoveredFrom: ['demo-3473'],
    related: ['demo-3474'],
    criteria: null,
    covers: null,
    status: 'draft',
    archived: '2026-01-01',
    error: 'Stale.',
  });
});

it('maps missing optional fields to null', () => {
  const view = ticketView(makeTicket('demo-3467'), false);

  expect(view.parent).toBeNull();
  expect(view.rank).toBeNull();
  expect(view.archived).toBeNull();
  expect(view.error).toBeNull();
});

it('adds the body only when asked', () => {
  const ticket = makeTicket('demo-3467');

  expect(ticketView(ticket, true).body).toBe('A body\n');
  expect('body' in ticketView(ticket, false)).toBe(false);
});

it('renders the heading and body, with the error line only for a broken ticket', () => {
  expect(ticketText(makeTicket('demo-3467'), 'open')).toBe('demo-3467  open  A title\nA body\n');
  const broken = ticketText(full, 'open');

  expect(broken).toContain(full.path);
  expect(broken).toContain('A body');
});

it('builds a storeError failure', () => {
  const failure = storeFailure('Cannot use /store.');

  expect(failure.ok).toBe(false);
  expect(!failure.ok && failure.reason.code).toBe('storeError');
  expect(!failure.ok && failure.reason.message).toContain('/store');
});

it('shows a ticket after a refresh', async () => {
  const fake = makeSession({ tickets: [makeTicket('demo-3467')] });

  fake.changeOnDisk(makeTicket('demo-3467', { hash: 'hash-after-write' }));

  const result = await showAfterRefresh(fake.session, new Date(), ticketIdOf('demo-3467'));

  expect(result.ok).toBe(true);

  if (result.ok) {
    expect(result.value.json).toMatchObject({
      id: 'demo-3467',
      hash: 'hash-after-write',
      body: 'A body\n',
    });

    expect(result.value.text).toContain('demo-3467');
  }
});

it('returns a storeError when the refresh fails', async () => {
  const fake = makeSession({
    overrides: {
      refresh: () => Promise.resolve({ ok: false, reason: { message: 'Refresh broke.' } }),
    },
  });

  const result = await showAfterRefresh(fake.session, new Date(), ticketIdOf('demo-3467'));

  expect(result.ok).toBe(false);
  expect(!result.ok && result.reason.code).toBe('storeError');
  expect(!result.ok && result.reason.message).toContain('Refresh');
});

it('returns a storeError naming the ID when the ticket is missing after refresh', async () => {
  const fake = makeSession();
  const result = await showAfterRefresh(fake.session, new Date(), ticketIdOf('demo-3467'));

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('storeError');
    expect(result.reason.message).toContain('demo-3467');
  }
});

it('finds a cached ticket', () => {
  const ticket = makeTicket('demo-3467');
  const { session } = makeSession({ tickets: [ticket] });

  expect(findTicket(session, 'demo-3467')).toEqual({ ok: true, value: ticket });
});

it('returns notFound naming the raw text for an invalid ID', () => {
  const { session } = makeSession();
  const result = findTicket(session, 'nonsense');

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('notFound');
    expect(result.reason.message).toContain('nonsense');
  }
});

it('returns notFound naming the ID for an unknown ticket', () => {
  const { session } = makeSession();
  const result = findTicket(session, 'demo-3467');

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('notFound');
    expect(result.reason.message).toContain('demo-3467');
  }
});

it('returns parseError with the path and cached detail for a file that did not parse', () => {
  const path = '/store/demo/demo-3467-bad.md';

  const { session } = makeSession({
    errors: [
      { path: '/store/other.md', message: 'Wrong file.' },
      { path, message: 'Bad YAML.' },
    ],
    overrides: {
      getTicket: () => ({ ok: false, reason: { message: 'missing' } }),
      findTicketPath: () => ({ ok: true, value: path }),
    },
  });

  const result = findTicket(session, 'demo-3467');

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('parseError');
    expect(result.reason.message).toContain(path);
    expect(result.reason.message).toContain('Bad YAML.');
    expect(result.reason.message).not.toContain('Wrong file.');
  }
});

it('returns parseError with the path when no cached detail exists', () => {
  const path = '/store/demo/demo-3467-bad.md';

  const { session } = makeSession({
    overrides: {
      getTicket: () => ({ ok: false, reason: { message: 'missing' } }),
      findTicketPath: () => ({ ok: true, value: path }),
    },
  });

  const result = findTicket(session, 'demo-3467');

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('parseError');
    expect(result.reason.message).toContain(path);
  }
});

it('does not look up an invalid ID', () => {
  const lookups: string[] = [];

  const { session } = makeSession({
    overrides: {
      getTicket: (id) => {
        lookups.push(id);

        return { ok: false, reason: { message: 'missing' } };
      },
    },
  });

  findTicket(session, 'nonsense');

  expect(lookups).toHaveLength(0);
});
