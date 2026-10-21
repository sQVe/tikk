import { afterEach, beforeEach, expect, it } from 'bun:test';

import type { CacheFiles, TicketCache } from '../src/cache/cache.ts';
import {
  createDatabaseFixture,
  createFakeFiles,
  factPath,
  factsOf,
  factText,
  makeGate,
  openTestCache,
  ticketPath,
  ticketText,
} from '../src/cache/cacheHarness.ts';
import { taskClaim } from '../src/cli/claimCommands.ts';
import { makeEffects, makeSession, ticketIdOf } from '../src/cli/cliHarness.ts';

let databasePath = '';
let cleanup = async () => {};

beforeEach(async () => {
  ({ databasePath, cleanup } = await createDatabaseFixture());
});

afterEach(async () => {
  await cleanup();
});

const claimAgainst = async (claimant: TicketCache, files: CacheFiles) => {
  const fakeSession = makeSession({
    overrides: {
      refresh: () => claimant.refresh(files),
      getTicket: (id) => claimant.getTicket(id),
      findTicketPath: (id) => claimant.findTicketPath(id),
      listErrors: () => claimant.listErrors(),
      listStateFacts: (ticketIds) => Promise.resolve(claimant.listStateFacts(ticketIds)),
    },
  });

  const { effects } = makeEffects({ session: fakeSession });

  const result = await taskClaim({
    args: ['tikk-3a4b', '--holder', 'agent'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  return { result, appends: fakeSession.appends };
};

it('refuses a claim on a task canceled while an older refresh was reading it', async () => {
  using reader = openTestCache(databasePath);
  using claimant = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');
  const openText = ticketText({ title: 'Task' });
  const gate = makeGate();

  fake.set(path, openText);
  await claimant.refresh(fake.files);
  fake.set(path, `${openText} `);

  const pausedFiles = {
    ...fake.files,
    readTicketFile: async (filePath: string) => {
      const read = await fake.files.readTicketFile(filePath);

      await gate.wait();

      return read;
    },
  };

  const readerRefresh = reader.refresh(pausedFiles);

  await gate.reached;
  fake.set(path, openText.replace('status: open', 'status: canceled'));

  // The reader writes its old row after the claimant's refresh and before its state check.
  const refreshThenResumeReader = async () => {
    const refreshed = await claimant.refresh(fake.files);

    gate.open();
    await readerRefresh;

    return refreshed;
  };

  const fakeSession = makeSession({
    overrides: {
      refresh: refreshThenResumeReader,
      getTicket: (id) => claimant.getTicket(id),
      findTicketPath: (id) => claimant.findTicketPath(id),
      listErrors: () => claimant.listErrors(),
      listStateFacts: (ticketIds) => Promise.resolve(claimant.listStateFacts(ticketIds)),
    },
  });

  const { effects } = makeEffects({ session: fakeSession });

  const result = await taskClaim({
    args: ['tikk-3a4b', '--holder', 'agent'],
    json: true,
    effects,
    session: fakeSession.session,
  });

  const cached = claimant.getTicket(ticketIdOf('tikk-3a4b'));

  expect(cached.ok && cached.value.frontMatter.status).toBe('canceled');
  expect(result).toMatchObject({ ok: false, reason: { code: 'conflict' } });
  expect(fakeSession.appends).toEqual([]);
});

it('refuses a claim on a canceled task when an older refresh writes before the claimant', async () => {
  using reader = openTestCache(databasePath);
  using claimant = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = ticketPath('tikk-3a4b');
  const openText = ticketText({ title: 'Task' });
  const gate = makeGate();

  fake.set(path, openText);
  await claimant.refresh(fake.files);
  fake.set(path, `${openText} `);

  const readerRefresh = reader.refresh({
    ...fake.files,
    readTicketFile: async (filePath: string) => {
      const read = await fake.files.readTicketFile(filePath);

      await gate.wait();

      return read;
    },
  });

  await gate.reached;
  fake.set(path, openText.replace('status: open', 'status: canceled'));

  let resumed = false;

  // The claimant has read the canceled file when the reader writes its older row.
  const { result, appends } = await claimAgainst(claimant, {
    ...fake.files,
    readTicketFile: async (filePath: string) => {
      const read = await fake.files.readTicketFile(filePath);

      if (!resumed) {
        resumed = true;
        gate.open();
        await readerRefresh;
      }

      return read;
    },
  });

  const cached = claimant.getTicket(ticketIdOf('tikk-3a4b'));

  expect(cached.ok && cached.value.frontMatter.status).toBe('canceled');
  expect(result).toMatchObject({ ok: false, reason: { code: 'conflict' } });
  expect(appends).toEqual([]);
});

it('refuses a claim on a task another holder claimed when an older fact refresh writes first', async () => {
  using reader = openTestCache(databasePath);
  using claimant = openTestCache(databasePath);
  const fake = createFakeFiles();
  const path = factPath();
  const note = { kind: 'log', type: 'progress', text: 'Note' };
  const claim = { kind: 'claim', holder: 'other', leaseEnd: '2026-10-21T10:00:00.000Z' };
  const gate = makeGate();

  fake.set(ticketPath('tikk-3a4b'), ticketText({ title: 'Task' }));
  fake.setFactFile(path, factText('tikk-3a4b', note));
  await claimant.refresh(fake.files);
  fake.setFactFile(path, factText('tikk-3a4b', note).repeat(2));

  const readerRefresh = reader.refresh({
    ...fake.files,
    readFactFile: async (filePath: string, fromByte: number) => {
      const read = await fake.files.readFactFile(filePath, fromByte);

      await gate.wait();

      return read;
    },
  });

  await gate.reached;
  fake.setFactFile(path, factText('tikk-3a4b', note).repeat(2) + factText('tikk-3a4b', claim));

  let resumed = false;

  // The claimant has read the other holder's claim when the reader indexes its older lines.
  const { result, appends } = await claimAgainst(claimant, {
    ...fake.files,
    readFactFile: async (filePath: string, fromByte: number) => {
      const read = await fake.files.readFactFile(filePath, fromByte);

      if (!resumed) {
        resumed = true;
        gate.open();
        await readerRefresh;
      }

      return read;
    },
  });

  expect(factsOf(claimant).map((fact) => fact.kind)).toEqual(['log', 'log', 'claim']);
  expect(result).toMatchObject({ ok: false, reason: { code: 'conflict' } });
  expect(appends).toEqual([]);
});
