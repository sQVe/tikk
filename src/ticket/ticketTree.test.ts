import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseProjectName, parseTicketId } from './ticket.ts';
import type { TicketFrontMatter, TicketId, TicketLookup } from './ticket.ts';
import { checkTicketTree, findWaitCycle } from './ticketTree.ts';

const idOf = (raw: string): TicketId => {
  const parsed = parseTicketId(raw);

  invariant(parsed.ok, `Test ID ${raw} is invalid.`);

  return parsed.value;
};

const project = parseProjectName('tikk');

invariant(project.ok, 'The test project must be valid.');

const known = idOf('tikk-3a4b');
const broken = idOf('tikk-3a4d');

const lookup: TicketLookup = (id) => {
  if (id === broken) {
    return { kind: 'task', hasFileError: true };
  }

  return id === known ? { kind: 'task', hasFileError: false } : undefined;
};

const issueWith = (fields: Partial<TicketFrontMatter>): TicketFrontMatter => ({
  kind: 'task',
  title: 'T',
  project: project.value,
  blockedBy: [],
  discoveredFrom: [],
  related: [],
  status: 'open',
  ...fields,
});

it('accepts edges whose targets all exist', () => {
  const planned = issueWith({ blockedBy: [known], discoveredFrom: [known], related: [known] });

  expect(checkTicketTree(planned, lookup).ok).toBe(true);
});

it('refuses a related target that does not exist after valid other edges', () => {
  const planned = issueWith({
    blockedBy: [known],
    discoveredFrom: [known],
    related: [idOf('tikk-3a4c')],
  });

  const checked = checkTicketTree(planned, lookup);

  expect(!checked.ok && checked.reason.message).toContain('tikk-3a4c');
});

it('refuses an edge target whose file has an error and names it', () => {
  const checked = checkTicketTree(issueWith({ related: [broken] }), lookup);

  expect(!checked.ok && checked.reason.message).toContain('tikk-3a4d');
  expect(!checked.ok && checked.reason.message).toContain('file error');
});

const waitTicket = (id: string, fields: { parent?: string; blockedBy?: string[] } = {}) => ({
  id: idOf(id),
  frontMatter: {
    ...(fields.parent === undefined ? {} : { parent: idOf(fields.parent) }),
    blockedBy: (fields.blockedBy ?? []).map(idOf),
  },
});

it('finds the blockedBy path that a new edge would close', () => {
  const tickets = [
    waitTicket('tikk-4a63'),
    waitTicket('tikk-4a64', { blockedBy: ['tikk-4a66'] }),
    waitTicket('tikk-4a66', { blockedBy: ['tikk-4a63'] }),
  ];

  expect(findWaitCycle(tickets, idOf('tikk-4a63'), idOf('tikk-4a64'))).toEqual([
    idOf('tikk-4a63'),
    idOf('tikk-4a64'),
    idOf('tikk-4a66'),
    idOf('tikk-4a63'),
  ]);
});

it('finds a cycle through a parent link', () => {
  const tickets = [waitTicket('tikk-4a63'), waitTicket('tikk-4a64', { parent: 'tikk-4a63' })];

  expect(findWaitCycle(tickets, idOf('tikk-4a63'), idOf('tikk-4a64'))).toEqual([
    idOf('tikk-4a63'),
    idOf('tikk-4a64'),
    idOf('tikk-4a63'),
  ]);
});

it('finds no cycle when the target does not wait on the ticket', () => {
  const tickets = [
    waitTicket('tikk-4a63', { blockedBy: ['tikk-4a66'] }),
    waitTicket('tikk-4a64', { parent: 'tikk-4a66', blockedBy: ['tikk-4a67', 'tikk-4a68'] }),
    waitTicket('tikk-4a66', { blockedBy: ['tikk-4a67'] }),
    waitTicket('tikk-4a67', { blockedBy: ['tikk-4a66', 'tikk-4a64'] }),
  ];

  expect(findWaitCycle(tickets, idOf('tikk-4a63'), idOf('tikk-4a64'))).toBeUndefined();
});

it('finds a cycle when a ticket waits on itself', () => {
  expect(findWaitCycle([waitTicket('tikk-4a63')], idOf('tikk-4a63'), idOf('tikk-4a63'))).toEqual([
    idOf('tikk-4a63'),
    idOf('tikk-4a63'),
  ]);
});
