import { expect, it } from 'bun:test';

import { makeEffects, makeFact, makeKindTicket, makeSession, stalledGh } from './cliHarness.ts';
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
