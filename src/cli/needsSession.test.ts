import { expect, it } from 'bun:test';

import {
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  stalledGh,
} from './cliHarness.ts';
import { openNeedsSession } from './needsSession.ts';

const prFact = makeFact({
  kind: 'pr',
  repository: 'acme/app',
  number: 7,
  state: 'open',
  base: 'main',
  head: 'head1',
  trunk: 'main',
  inTrunk: false,
});

const waitFor = async (ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000;

  while (!ready() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
};

it('stops the gh child of a pending load and disposes the session only after the load settles', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact],
  });

  const signals: AbortSignal[] = [];

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: (args, signal) => {
      signals.push(signal);

      return stalledGh(args, signal);
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const loading = opened.value.load();

  await waitFor(() => signals.length > 0);

  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(false);

  let loadSettled = false;
  let disposedAtSettle: boolean | undefined;

  const settled = (async () => {
    await loading;
    loadSettled = true;
    disposedAtSettle = fakeSession.disposed();
  })();

  await opened.value.close();
  await settled;

  expect(signals[0]?.aborted).toBe(true);
  expect(loadSettled).toBe(true);
  expect(disposedAtSettle).toBe(false);
  expect(fakeSession.disposed()).toBe(true);
});

it('disposes the session when no load is pending', async () => {
  const fakeSession = makeSession();
  const fakeEffects = makeEffects({ session: fakeSession });
  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (opened.ok) {
    await opened.value.close();
  }

  expect(fakeSession.disposed()).toBe(true);
});

it('loads the plan tree from the session tickets and facts', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'plan'), makeKindTicket('demo-3468', 'issue')],
  });

  const fakeEffects = makeEffects({ session: fakeSession });
  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const tree = await opened.value.loadTree();

  await opened.value.close();

  expect(tree.ok).toBe(true);

  if (tree.ok) {
    expect(tree.value.map((group) => String(group.plan?.id))).toEqual(['demo-3467']);
  }
});

it('keeps a slice active when an archived accepted task is its only started task', async () => {
  const base = makeKindTicket('demo-3467', 'slice');

  const slice = makeTicket('demo-3467', {
    frontMatter: { ...base.frontMatter, title: 'The slice' },
  });

  const taskBase = makeKindTicket('demo-3468', 'task');
  const parent = slice.id;

  const archived = makeTicket('demo-3468', {
    frontMatter: { ...taskBase.frontMatter, parent, archived: '2026-10-01' },
  });

  const open = makeTicket('demo-3469', { frontMatter: { ...taskBase.frontMatter, parent } });

  const fakeSession = makeSession({
    tickets: [slice, archived, open],
    facts: [makeFact({ kind: 'accept', ticket: 'demo-3468' })],
  });

  const opened = await openNeedsSession(makeEffects({ session: fakeSession }).effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const tree = await opened.value.loadTree();

  await opened.value.close();

  expect(tree.ok).toBe(true);

  if (tree.ok) {
    const [group] = tree.value;

    expect(group?.slices.map((entry) => entry.state)).toEqual(['active']);
    expect(group?.slices[0]?.tasks.map((task) => String(task.id))).toEqual(['demo-3469']);
  }
});
