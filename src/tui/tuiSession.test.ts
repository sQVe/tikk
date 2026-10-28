import { expect, it } from 'bun:test';

import type { CliFailure, NeedView, NeedsReading, TreeGroup } from '../cli/cli.ts';
import type { Result } from '../result.ts';
import { needView, treeGroups } from './tuiHarness.tsx';
import { createTuiSession } from './tuiSession.ts';
import type { TuiEffects, TuiSession, TuiSnapshot } from './tuiSession.ts';

type Reading = Result<NeedsReading, CliFailure>;

interface FakeTui {
  session: TuiSession;
  items: NeedView[];
  groups: TreeGroup[];
  fileErrors: { path: string; id: string | null; message: string }[];
  edited: string[];
  changeListeners: Set<() => void>;
  setHomeFailure: (message: string | undefined) => void;
}

const settle = (): Promise<void> => Bun.sleep(5);

const reading = (items: NeedView[]): Reading => ({
  ok: true,
  value: { items: [...items], reconcileProblems: [] },
});

const createFake = async (
  items: NeedView[],
  groups: TreeGroup[] = [],
  overrides: Partial<TuiEffects> = {},
): Promise<FakeTui> => {
  const changeListeners = new Set<() => void>();
  const edited: string[] = [];
  const fileErrors: { path: string; id: string | null; message: string }[] = [];
  let homeFailure: string | undefined;

  const effects: TuiEffects = {
    load: async () =>
      homeFailure === undefined
        ? reading(items)
        : { ok: false, reason: { code: 'storeError', message: homeFailure } },
    loadTree: async () => ({ ok: true, value: structuredClone(groups) }),
    loadErrors: async () => ({ ok: true, value: [...fileErrors] }),
    edit: async (rawId) => {
      edited.push(rawId);

      return { ok: true, value: undefined };
    },
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: (listener) => {
      changeListeners.add(listener);

      return () => {
        changeListeners.delete(listener);
      };
    },
    notices: [],
    ...overrides,
  };

  const session = createTuiSession(effects);

  await settle();

  return {
    session,
    items,
    groups,
    fileErrors,
    edited,
    changeListeners,
    setHomeFailure: (message) => {
      homeFailure = message;
    },
  };
};

const storeChanged = async (fake: FakeTui): Promise<void> => {
  for (const listener of fake.changeListeners) {
    listener();
  }

  await settle();
};

const selectedOf = (snapshot: TuiSnapshot) => snapshot.views[snapshot.view].selection;

const blocked = (fingerprint: string): NeedView => ({
  ...needView(0, 'Same ticket'),
  reason: 'blockedFinding',
  fingerprint,
  claim: `${fingerprint} problem`,
});

it('keeps the selected ticket after a reload removes the rows above it', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second'), needView(2, 'Third')];
  const fake = await createFake(items);

  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'moveDown' });
  items.splice(0, 2);
  await storeChanged(fake);

  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3402');
});

it('keeps the selected row key across a reload when two rows share a ticket', async () => {
  const items = [blocked('first'), blocked('second')];
  const fake = await createFake(items);

  fake.session.send({ kind: 'moveDown' });
  items.unshift(needView(5, 'Added'), blocked('third'));
  await storeChanged(fake);

  expect(selectedOf(fake.session.getSnapshot()).key).toBe('demo-3400:blockedFinding:second');
});

it('selects the first row of the same ticket when a reload removes the selected row key', async () => {
  const items = [needView(5, 'Other'), blocked('first'), blocked('second')];
  const fake = await createFake(items);

  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'moveDown' });
  items.splice(0, 3, needView(6, 'Another'), needView(7, 'More'), blocked('third'));
  await storeChanged(fake);

  expect(selectedOf(fake.session.getSnapshot()).key).toBe('demo-3400:blockedFinding:third');
});

it('keeps the selected ticket on a view switch when the other view has it', async () => {
  const fake = await createFake([needView(0, 'First'), needView(2, 'Instruction')], treeGroups());

  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'switchView' });
  await settle();

  expect(fake.session.getSnapshot().view).toBe('tree');
  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3402');

  fake.session.send({ kind: 'moveUp' });
  fake.session.send({ kind: 'switchView' });

  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3402');

  fake.session.send({ kind: 'switchView' });

  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3402');

  fake.session.send({ kind: 'moveUp' });
  fake.session.send({ kind: 'switchView' });
  fake.session.send({ kind: 'moveUp' });
  fake.session.send({ kind: 'switchView' });

  expect(fake.session.getSnapshot().view).toBe('tree');
  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3401');
});

it("keeps the other view's own selection on a view switch when it lacks the ticket", async () => {
  const fake = await createFake([needView(0, 'First'), needView(7, 'Home only')], treeGroups());

  fake.session.send({ kind: 'switchView' });
  await settle();
  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'switchView' });
  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'switchView' });

  expect(selectedOf(fake.session.getSnapshot()).id).toBe('demo-3402');
});

it('keeps the previous rows and stores the error when a reload fails', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const fake = await createFake(items);

  fake.session.send({ kind: 'moveDown' });
  fake.setHomeFailure('Home read failed.');
  items.splice(0, 2);
  await storeChanged(fake);

  const home = fake.session.getSnapshot().views.home;

  expect(home.rows.map((row) => row.id)).toEqual(['demo-3400', 'demo-3401']);
  expect(home.failure).toBe('Home read failed.');
  expect(home.selection.id).toBe('demo-3401');

  fake.setHomeFailure(undefined);
  items.push(needView(2, 'Third'));
  await storeChanged(fake);

  expect(fake.session.getSnapshot().views.home.failure).toBeUndefined();
  expect(fake.session.getSnapshot().views.home.rows.map((row) => row.id)).toEqual(['demo-3402']);
});

it('returns the same snapshot and notifies nobody when no transition ran', async () => {
  const fake = await createFake([needView(0, 'First')]);
  let notified = 0;

  fake.session.subscribe(() => {
    notified += 1;
  });

  const before = fake.session.getSnapshot();

  fake.session.send({ kind: 'moveUp' });
  fake.session.send({ kind: 'moveDown' });

  expect(fake.session.getSnapshot()).toBe(before);
  expect(fake.session.getSnapshot()).toBe(fake.session.getSnapshot());
  expect(notified).toBe(0);
});

it('publishes neither the rows nor the file errors of a superseded load, and notifies nobody', async () => {
  const gates: PromiseWithResolvers<Reading>[] = [];

  const listings = [
    [{ path: 'tickets/demo-3400.md', id: null, message: 'Old error.' }],
    [{ path: 'tickets/demo-3401.md', id: null, message: 'New error.' }],
  ];

  let started = 0;
  let notified = 0;

  const fake = await createFake([], [], {
    load: () => {
      started += 1;

      const gate = Promise.withResolvers<Reading>();

      gates.push(gate);

      return gate.promise;
    },
    loadErrors: async () => ({ ok: true, value: listings.shift() ?? [] }),
  });

  fake.session.subscribe(() => {
    notified += 1;
  });

  const before = fake.session.getSnapshot();

  await storeChanged(fake);
  gates[0]?.resolve(reading([needView(0, 'Old')]));
  await settle();

  expect(started).toBe(2);
  expect(fake.session.getSnapshot()).toBe(before);
  expect(notified).toBe(0);

  gates[1]?.resolve(reading([needView(1, 'New')]));
  await settle();

  expect(fake.session.getSnapshot().views.home.rows.map((row) => row.id)).toEqual(['demo-3401']);

  expect(fake.session.getSnapshot().fileErrors).toEqual([
    { path: 'tickets/demo-3401.md', id: null, message: 'New error.' },
  ]);

  expect(notified).toBe(1);
});

it('starts no effect after stop, neither for a queued reload nor after the running one', async () => {
  const gate = Promise.withResolvers<Reading>();
  const calls: string[] = [];

  const fake = await createFake([], [], {
    load: () => {
      calls.push('load');

      return gate.promise;
    },
    loadErrors: async () => {
      calls.push('loadErrors');

      return { ok: true, value: [] };
    },
  });

  await storeChanged(fake);
  fake.session.stop();
  gate.resolve(reading([needView(0, 'First')]));
  await settle();

  expect(calls).toEqual(['load']);
});

it('holds the ticket files that failed to parse after each reload', async () => {
  const fake = await createFake([]);

  expect(fake.session.getSnapshot().fileErrors).toEqual([]);

  fake.fileErrors.push({
    path: 'tickets/demo-3400.md',
    id: null,
    message: 'Front matter is invalid.',
  });

  await storeChanged(fake);

  expect(fake.session.getSnapshot().fileErrors).toEqual([
    { path: 'tickets/demo-3400.md', id: null, message: 'Front matter is invalid.' },
  ]);
});

it('opens the selected ticket in the editor and shows its failure as the notice', async () => {
  const fake = await createFake([needView(0, 'First'), needView(1, 'Second')], [], {
    edit: async () => ({ ok: false, reason: { code: 'storeError', message: 'Editor failed.' } }),
  });

  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'edit' });
  await settle();

  expect(fake.session.getSnapshot().notice).toBe('Editor failed.');
});

it('stops reloading, moving, and editing after stop', async () => {
  const items = [needView(0, 'First'), needView(1, 'Second')];
  const fake = await createFake(items);
  let notified = 0;

  fake.session.subscribe(() => {
    notified += 1;
  });

  const before = fake.session.getSnapshot();

  fake.session.stop();
  items.push(needView(1, 'Second'));
  await storeChanged(fake);
  fake.session.send({ kind: 'moveDown' });
  fake.session.send({ kind: 'edit' });
  await settle();

  expect(fake.changeListeners.size).toBe(0);
  expect(fake.session.getSnapshot()).toBe(before);
  expect(fake.edited).toEqual([]);
  expect(notified).toBe(0);
});

it('stops notifying a listener after it unsubscribes', async () => {
  const fake = await createFake([needView(0, 'First'), needView(1, 'Second')]);
  let notified = 0;

  const unsubscribe = fake.session.subscribe(() => {
    notified += 1;
  });

  fake.session.send({ kind: 'moveDown' });
  unsubscribe();
  fake.session.send({ kind: 'moveUp' });

  expect(notified).toBe(1);
});

it('loads the plan tree only on the first switch to it and on later store changes', async () => {
  let treeLoads = 0;

  const fake = await createFake([needView(0, 'First')], treeGroups(), {
    loadTree: async () => {
      treeLoads += 1;

      return { ok: true, value: treeGroups() };
    },
  });

  expect(treeLoads).toBe(0);

  fake.session.send({ kind: 'switchView' });
  fake.session.send({ kind: 'switchView' });
  fake.session.send({ kind: 'switchView' });
  await settle();

  expect(treeLoads).toBe(1);

  await storeChanged(fake);

  expect(treeLoads).toBe(2);
});

it('stores the error of a load that throws', async () => {
  const fake = await createFake([], [], { load: () => Promise.reject(new Error('Disk is gone.')) });

  expect(fake.session.getSnapshot().views.home.failure).toBe('Disk is gone.');
});

it('keeps the previous ticket file errors when listing them fails', async () => {
  const fileError = { path: 'tickets/demo-3400.md', id: null, message: 'Front matter is invalid.' };
  let listings = 0;

  const fake = await createFake([], [], {
    loadErrors: () => {
      listings += 1;

      return listings === 1
        ? Promise.resolve({ ok: true, value: [fileError] })
        : Promise.reject(new Error('Gone.'));
    },
  });

  await storeChanged(fake);

  expect(listings).toBe(2);
  expect(fake.session.getSnapshot().fileErrors).toEqual([fileError]);
});

it('stops growing the message history after many notices', async () => {
  const fake = await createFake([needView(0, 'First')], [], {
    edit: async () => ({ ok: false, reason: { code: 'storeError', message: 'Editor failed.' } }),
  });

  const editOnce = async () => {
    fake.session.send({ kind: 'edit' });
    await settle();
  };

  for (let count = 0; count < 120; count += 1) {
    await editOnce();
  }

  const bounded = fake.session.getSnapshot().messages.length;

  for (let count = 0; count < 30; count += 1) {
    await editOnce();
  }

  expect(fake.session.getSnapshot().messages).toHaveLength(bounded);
});

it('keeps only the failure in the history when a later edit succeeds', async () => {
  const outcomes = [
    { ok: false as const, reason: { code: 'storeError' as const, message: 'Editor failed.' } },
    { ok: true as const, value: undefined },
  ];

  const fake = await createFake([needView(0, 'First')], [], {
    edit: async () => outcomes.shift() ?? { ok: true, value: undefined },
  });

  fake.session.send({ kind: 'edit' });
  await settle();
  fake.session.send({ kind: 'edit' });
  await settle();

  expect(fake.session.getSnapshot().messages.map((message) => message.text)).toEqual([
    'Editor failed.',
  ]);
});

it('does not edit when the selected row has no ticket, even if edit is sent', async () => {
  const groups: TreeGroup[] = [{ plan: null, slices: [] }];
  const fake = await createFake([], groups);

  fake.session.send({ kind: 'switchView' });
  await settle();
  fake.session.send({ kind: 'edit' });
  await settle();

  expect(fake.session.getSnapshot().view).toBe('tree');
  expect(fake.edited).toEqual([]);
});

it('reports a stray file error that appears after an earlier one was already reported', async () => {
  const fake = await createFake([needView(0, 'First')]);

  const reload = async () => {
    for (const listener of fake.changeListeners) {
      listener();
    }

    await settle();
  };

  fake.fileErrors.push({ path: 'a.md', id: null, message: 'Broken A' });
  await reload();
  fake.fileErrors.push({ path: 'b.md', id: null, message: 'Broken B' });
  await reload();

  const texts = fake.session.getSnapshot().messages.map((message) => message.text);

  expect(texts.some((text) => text.includes('Broken A'))).toBe(true);
  expect(texts.some((text) => text.includes('Broken B'))).toBe(true);
});

it('does not report a file error for a ticket that has a row', async () => {
  const fake = await createFake([needView(0, 'First')]);

  fake.fileErrors.push({ path: 'first.md', id: 'demo-3400', message: 'Broken' });

  for (const listener of fake.changeListeners) {
    listener();
  }

  await settle();

  expect(fake.session.getSnapshot().messages).toEqual([]);
});

it('shows no problem for a tree that loads without one', async () => {
  const fake = await createFake([needView(0, 'First')], treeGroups());

  fake.session.send({ kind: 'switchView' });
  await settle();

  expect(fake.session.getSnapshot().views.tree.problems).toEqual([]);
});

it('refreshes the rows when listing the file errors fails', async () => {
  const changes = new Set<() => void>();
  let title = 'Before';
  let failListing = false;

  const session = createTuiSession({
    load: async () => ({ ok: true, value: { items: [needView(0, title)], reconcileProblems: [] } }),
    loadTree: async () => ({ ok: true, value: [] }),
    loadErrors: async () => {
      if (failListing) {
        throw new Error('Listing failed.');
      }

      return { ok: true, value: [] };
    },
    edit: async () => ({ ok: true, value: undefined }),
    lend: async (run) => ({ ok: true, value: await run() }),
    onChange: (listener) => {
      changes.add(listener);

      return () => changes.delete(listener);
    },
    notices: [],
  });

  await settle();

  title = 'After';
  failListing = true;

  for (const listener of changes) {
    listener();
  }

  await settle();

  const texts = session.getSnapshot().views.home.rows.map((row) => row.text);

  session.stop();

  expect(texts.some((text) => text.includes('After'))).toBe(true);
});
