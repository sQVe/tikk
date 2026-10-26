import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseProjectName, parseTicketId } from './ticket.ts';
import type { TicketFrontMatter, TicketId, TicketLookup } from './ticket.ts';
import { checkTicketTree } from './ticketTree.ts';

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
