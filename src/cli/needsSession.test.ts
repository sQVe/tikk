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
    tickets: [makeKindTicket('demo-3467', 'plan'), makeKindTicket('demo-3468', 'task')],
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

it('keeps a slice active when an archived accepted instruction is its only started instruction', async () => {
  const base = makeKindTicket('demo-3467', 'slice');

  const slice = makeTicket('demo-3467', {
    frontMatter: { ...base.frontMatter, title: 'The slice' },
  });

  const instructionBase = makeKindTicket('demo-3468', 'instruction');
  const parent = slice.id;

  const archived = makeTicket('demo-3468', {
    frontMatter: { ...instructionBase.frontMatter, parent, archived: '2026-10-01' },
  });

  const open = makeTicket('demo-3469', { frontMatter: { ...instructionBase.frontMatter, parent } });

  const fakeSession = makeSession({
    tickets: [slice, archived, open],
    facts: [
      makeFact({
        kind: 'log',
        type: 'submitted',
        text: '',
        item: '5ab0000000a1',
        ticket: 'demo-3468',
      }),
      makeFact({ kind: 'accept', item: '5ab0000000a1', ticket: 'demo-3468' }),
    ],
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

    expect(group?.slices[0]?.instructions.map((instruction) => String(instruction.id))).toEqual([
      'demo-3469',
    ]);
  }
});

it('runs one load at a time, so a second load starts only after the first settles', async () => {
  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact],
  });

  const firstGh = Promise.withResolvers<undefined>();
  const ghCalls: string[][] = [];

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: async (args) => {
      ghCalls.push(args);

      if (ghCalls.length === 1) {
        await firstGh.promise;
      }

      return { ok: false, reason: { message: 'gh is offline.' } };
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const first = opened.value.load();
  const second = opened.value.load();

  await waitFor(() => ghCalls.length > 0);
  await Bun.sleep(30);

  expect(ghCalls).toHaveLength(1);

  firstGh.resolve(undefined);
  await Promise.all([first, second]);
  await opened.value.close();

  expect(ghCalls.length).toBeGreaterThan(1);
});

it('lists the ticket files that failed to parse once the pending load settles', async () => {
  const errors = [{ path: 'tickets/demo-3467.md', message: 'Front matter is invalid.' }];

  const fakeSession = makeSession({
    tickets: [makeKindTicket('demo-3467', 'slice')],
    facts: [prFact],
    errors,
  });

  const gh = Promise.withResolvers<undefined>();
  let ghCalls = 0;

  const fakeEffects = makeEffects({
    session: fakeSession,
    runGh: async () => {
      ghCalls += 1;
      await gh.promise;

      return { ok: false, reason: { message: 'gh is offline.' } };
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const loading = opened.value.load();
  let listed: { path: string; message: string }[] | undefined;

  const listing = (async () => {
    listed = await opened.value.loadErrors();
  })();

  await waitFor(() => ghCalls > 0);
  await Bun.sleep(30);

  expect(listed).toBeUndefined();

  gh.resolve(undefined);
  await Promise.all([loading, listing]);
  await opened.value.close();

  expect(listed).toEqual(errors);
});

it('opens the editor on the ticket file and waits for it before it closes', async () => {
  const target = makeTicket('demo-3467');
  const fakeSession = makeSession({ tickets: [target] });
  const editorDone = Promise.withResolvers<undefined>();
  const editorPaths: string[] = [];

  const fakeEffects = makeEffects({
    session: fakeSession,
    overrides: {
      runEditor: async (path) => {
        editorPaths.push(path);
        await editorDone.promise;

        return { ok: true, value: undefined };
      },
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const editing = opened.value.edit('demo-3467');
  const closing = opened.value.close();

  await Bun.sleep(30);

  expect(editorPaths).toEqual([target.path]);
  expect(fakeSession.disposed()).toBe(false);

  editorDone.resolve(undefined);

  expect(await editing).toEqual({ ok: true, value: undefined });

  await closing;

  expect(fakeSession.disposed()).toBe(true);
});

it('returns the editor failure', async () => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')] });

  const fakeEffects = makeEffects({
    session: fakeSession,
    overrides: {
      runEditor: () =>
        Promise.resolve({
          ok: false,
          reason: { kind: 'failed', message: 'The editor "vi" exited with 1.' },
        }),
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const edited = await opened.value.edit('demo-3467');

  await opened.value.close();

  expect(edited.ok).toBe(false);

  if (!edited.ok) {
    expect(edited.reason.message).toContain('exited with 1');
  }
});

it.each(['cancelled', 'cleanup'] as const)(
  'preserves %s editor outcomes when closing twice and disposes the session once',
  async (kind) => {
    let disposals = 0;

    const fakeSession = makeSession({
      tickets: [makeTicket('demo-3467')],
      overrides: {
        [Symbol.dispose]: () => {
          disposals += 1;
        },
      },
    });

    const signals: AbortSignal[] = [];
    const reason = { kind, message: 'Editor stopped.' };

    const fakeEffects = makeEffects({
      session: fakeSession,
      overrides: {
        runEditor: (_path, signal) => {
          signals.push(signal);

          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              resolve({ ok: false, reason });
            });
          });
        },
      },
    });

    const opened = await openNeedsSession(fakeEffects.effects);

    expect(opened.ok).toBe(true);

    if (!opened.ok) {
      return;
    }

    const editing = opened.value.edit('demo-3467');

    await waitFor(() => signals.length > 0);

    const first = opened.value.close();
    const second = opened.value.close();

    const expected: Awaited<ReturnType<typeof opened.value.close>> =
      kind === 'cleanup'
        ? { ok: false, reason: { kind: 'cleanup', message: reason.message } }
        : { ok: true, value: undefined };

    expect(await first).toEqual(expected);
    expect(await second).toEqual(expected);
    expect((await editing).ok).toBe(false);
    expect(disposals).toBe(1);
  },
);

it('stops the editor of a pending edit when the session closes', async () => {
  const fakeSession = makeSession({ tickets: [makeTicket('demo-3467')] });
  const signals: AbortSignal[] = [];

  const fakeEffects = makeEffects({
    session: fakeSession,
    overrides: {
      runEditor: (_path, signal) => {
        signals.push(signal);

        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({
              ok: false,
              reason: { kind: 'cancelled', message: 'The editor was stopped.' },
            });
          });
        });
      },
    },
  });

  const opened = await openNeedsSession(fakeEffects.effects);

  expect(opened.ok).toBe(true);

  if (!opened.ok) {
    return;
  }

  const editing = opened.value.edit('demo-3467');

  await waitFor(() => signals.length > 0);
  await opened.value.close();

  expect(signals[0]?.aborted).toBe(true);
  expect((await editing).ok).toBe(false);
  expect(fakeSession.disposed()).toBe(true);
});
