import { expect, it } from 'bun:test';

import { criterionFingerprint } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import {
  failureOf,
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  projectNameOf,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import { ticketShow } from './ticketShow.ts';

const show = (
  args: string[],
  tickets = [makeTicket('demo-3467')],
  facts: Fact[] = [],
  folderFiles: Record<string, string[]> = {},
) => {
  const { session } = makeSession({ tickets, facts, folderFiles });
  const { effects } = makeEffects();

  return ticketShow({ args, json: false, effects, session });
};

it('shows a ticket as json with its body and as text', async () => {
  const output = successOf(await show(['demo-3467']));

  expect(output.json).toMatchObject({ id: 'demo-3467', title: 'A title', body: 'A body\n' });
  expect(output.text).toContain('demo-3467');
  expect(output.text).toContain('A body');
});

it("lists the files in the ticket's folder", async () => {
  const plan = makeKindTicket('demo-3467', 'plan');
  const folderFiles = { 'demo-3467': ['design.md', 'reports/review.md'] };

  const withFolder = successOf(await show(['demo-3467'], [plan], [], folderFiles));
  const withoutFolder = successOf(await show(['demo-3469'], [makeKindTicket('demo-3469', 'plan')]));

  expect(withFolder.json).toMatchObject({ files: ['design.md', 'reports/review.md'] });
  expect(withoutFolder.json).toMatchObject({ files: [] });
});

it('refuses a missing ID with a usage message', async () => {
  const reason = failureOf(await show([]));

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('tikk show');
});

it('refuses extra positionals', async () => {
  expect(failureOf(await show(['demo-3467', 'demo-3468'])).code).toBe('invalidArguments');
});

it('refuses unknown options', async () => {
  expect(failureOf(await show(['demo-3467', '--bogus'])).code).toBe('invalidArguments');
});

it('returns notFound with the ID for an unknown ticket', async () => {
  const reason = failureOf(await show(['demo-3468']));

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
});

it('shows the state of an instruction and its claim while the claim is active', async () => {
  const claim = makeFact({ kind: 'claim', holder: 'agent', leaseEnd: '2026-10-20T13:00:00.000Z' });
  const open = successOf(await show(['demo-3467']));
  const active = successOf(await show(['demo-3467'], [makeTicket('demo-3467')], [claim]));

  expect(open.json).toMatchObject({ state: 'open', claim: null });

  expect(active.json).toMatchObject({
    state: 'active',
    claim: {
      holder: 'agent',
      leaseEnd: '2026-10-20T13:00:00.000Z',
      session: null,
      sessionLog: null,
    },
  });
});

it('shows no state for a task', async () => {
  const task = makeTicket('demo-3467', {
    frontMatter: {
      kind: 'task',
      title: 'A task',
      project: projectNameOf('demo'),
      blockedBy: [],
      discoveredFrom: [],
      related: [],
      status: 'done',
    },
  });

  const output = successOf(await show(['demo-3467'], [task]));

  expect(output.json).not.toHaveProperty('state');
  expect(output.json).not.toHaveProperty('claim');
});

it('prints the derived state of an instruction in text, not the front matter status', async () => {
  const submission = makeFact({ kind: 'log', type: 'submitted', text: '', item: '5ab0000000a1' });
  const accept = makeFact({ kind: 'accept', item: '5ab0000000a1' });

  const output = successOf(
    await show(['demo-3467'], [makeTicket('demo-3467')], [submission, accept]),
  );

  expect(output.text).toContain('demo-3467  done  A title');
  expect(output.text).not.toContain('demo-3467  open');
});

it('shows a merged open slice with its derived state, PR, and open instructions', async () => {
  const slice = makeKindTicket('demo-3469', 'slice');

  const instruction = makeTicket('demo-3478', {
    frontMatter: { ...makeTicket('demo-3478').frontMatter, parent: ticketIdOf('demo-3469') },
  });

  const merged = makeFact({
    ticket: 'demo-3469',
    kind: 'pr',
    repository: 'sqve/tikk',
    number: 7,
    state: 'merged',
    base: 'main',
    head: 'aaa',
    trunk: 'main',
    inTrunk: true,
  });

  const output = successOf(await show(['demo-3469'], [slice, instruction], [merged]));

  expect(output.json).toMatchObject({
    id: 'demo-3469',
    state: 'mergedUnverified',
    since: '2026-10-20T11:00:00.000Z',
    ageSeconds: 3600,
    openTasks: [],
    openInstructions: ['demo-3478'],
    pr: {
      repository: 'sqve/tikk',
      number: 7,
      state: 'merged',
      base: 'main',
      head: 'aaa',
      mergeCommit: null,
      inTrunk: true,
      checkedAt: '2026-10-20T11:00:00.000Z',
    },
  });

  expect(output.text).toContain('demo-3469  mergedUnverified');
});

it('shows a planned slice with no PR', async () => {
  const output = successOf(await show(['demo-3469'], [makeKindTicket('demo-3469', 'slice')]));

  expect(output.json).toMatchObject({ state: 'planned', since: null, ageSeconds: null, pr: null });
});

it('keeps the status of a draft slice', async () => {
  const output = successOf(
    await show(['demo-3469'], [makeKindTicket('demo-3469', 'slice', 'draft')]),
  );

  expect(output.json).toMatchObject({ state: 'draft', pr: null });
  expect(output.text).toContain('demo-3469  draft');
});

it('shows a plan as done in json once its only slice is done, and keeps its stored status', async () => {
  const plan = makeKindTicket('demo-3466', 'plan');

  const slice = makeTicket('demo-3469', {
    frontMatter: {
      ...makeKindTicket('demo-3469', 'slice').frontMatter,
      parent: ticketIdOf('demo-3466'),
      criteria: [{ id: 'works', check: 'Run it.', expected: 'It works.' }],
    },
  });

  const merged = makeFact({
    ticket: 'demo-3469',
    kind: 'pr',
    repository: 'sqve/tikk',
    number: 7,
    state: 'merged',
    base: 'main',
    head: 'aaa',
    trunk: 'main',
    inTrunk: true,
  });

  const audit = makeFact({
    ticket: 'demo-3469',
    kind: 'audit',
    repository: 'sqve/tikk',
    changeHash: 'hash1',
    head: 'aaa',
    base: 'main',
    verdicts: [
      {
        criterion: 'works',
        verdict: 'met',
        evidence: 'Ran it.',
        definition: criterionFingerprint({ check: 'Run it.', expected: 'It works.' }),
      },
    ],
  });

  const instruction = makeTicket('demo-3479', {
    frontMatter: {
      ...makeTicket('demo-3479').frontMatter,
      parent: ticketIdOf('demo-3469'),
    },
  });

  const submitted = makeFact({
    ticket: 'demo-3479',
    kind: 'log',
    type: 'submitted',
    text: '',
    item: '5ab0000000a1',
  });

  const accepted = makeFact({ ticket: 'demo-3479', kind: 'accept', item: '5ab0000000a1' });

  const output = successOf(
    await show(['demo-3466'], [plan, slice, instruction], [merged, audit, submitted, accepted]),
  );

  expect(output.json).toMatchObject({ status: 'open', state: 'done' });
});
