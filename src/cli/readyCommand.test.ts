import { expect, it } from 'bun:test';

import type { Fact } from '../fact/fact.ts';
import type { CliTicket } from './cliEffects.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import { readyCommand } from './readyCommand.ts';

const taskWith = (id: string, fields: Partial<CliTicket['frontMatter']>): CliTicket => {
  const base = makeTicket(id);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, ...fields } });
};

const ready = (args: string[], tickets: CliTicket[], facts: Fact[] = []) => {
  const fakeSession = makeSession({ tickets, facts });
  const { effects } = makeEffects({ session: fakeSession });

  return readyCommand({ args, json: true, effects, session: fakeSession.session });
};

it('lists open tasks as candidates and names the blockers of a skipped task', () => {
  const blocked = taskWith('demo-3467', { rank: 1, blockedBy: [ticketIdOf('demo-3468')] });
  const blocker = taskWith('demo-3468', { rank: 2, title: 'Blocker' });
  const output = successOf(ready([], [blocked, blocker]));

  expect(output.json).toEqual({
    candidates: [expect.objectContaining({ id: 'demo-3468', title: 'Blocker', state: 'open' })],
    skipped: [
      {
        id: 'demo-3467',
        title: 'A title',
        reason: 'blocked',
        blockers: [{ id: 'demo-3468', state: 'open' }],
      },
    ],
  });

  expect(output.json).not.toHaveProperty('candidates.0.body');
  expect(output.text).toContain('skipped: demo-3467  blocked');
});

it('names the holder and lease end of a skipped active task', () => {
  const active = taskWith('demo-3467', { rank: 1 });
  const open = taskWith('demo-3468', { rank: 2 });

  const claim = makeFact({
    kind: 'claim',
    holder: 'agent',
    leaseEnd: '2026-10-20T13:00:00.000Z',
  });

  const output = successOf(ready([], [active, open], [claim]));

  expect(output.json).toMatchObject({
    candidates: [{ id: 'demo-3468' }],
    skipped: [
      { id: 'demo-3467', reason: 'active', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' },
    ],
  });
});

it('treats a blocker that is archived and canceled as cleared', () => {
  const blocked = taskWith('demo-3467', { blockedBy: [ticketIdOf('demo-3468')] });
  const archived = taskWith('demo-3468', { status: 'canceled', archived: '2026-10-01' });
  const output = successOf(ready([], [blocked, archived]));

  expect(output.json).toMatchObject({ candidates: [{ id: 'demo-3467' }], skipped: [] });
});

it('limits candidates to a project and a parent', () => {
  const other = taskWith('other-3467', { project: projectNameOf('other') });
  const child = taskWith('demo-3467', { parent: ticketIdOf('demo-3469') });
  const loose = taskWith('demo-3468', {});
  const byProject = successOf(ready(['--project', 'other'], [other, child, loose]));
  const byParent = successOf(ready(['--parent', 'demo-3469'], [other, child, loose]));

  expect(byProject.json).toMatchObject({ candidates: [{ id: 'other-3467' }] });
  expect(byParent.json).toMatchObject({ candidates: [{ id: 'demo-3467' }] });
});

it('refuses positionals', () => {
  expect(failureOf(ready(['demo-3467'], [])).code).toBe('invalidArguments');
});
