import { parseFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import { parseProjectName, parseTicketId } from '../ticket/ticket.ts';
import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import type { CliEffects, CliFailure, CliSession, CliTicket, CommandResult } from './cliEffects.ts';

interface FakeWrite {
  path: string;
  expectedHash: string;
  text: string;
}

interface FakeCreate {
  project: string;
  title: string;
  text: string;
}

export interface SessionOptions {
  tickets?: CliTicket[];
  facts?: Fact[];
  errors?: { path: string; message: string }[];
  created?: CliTicket;
  overrides?: Partial<CliSession>;
}

export interface FakeSession {
  session: CliSession;
  writes: FakeWrite[];
  creates: FakeCreate[];
  appends: { machine: string; fact: Fact }[];
  listOptions: { includeArchived: boolean }[];
  refreshes: () => number;
  locks: () => number;
  releases: () => number;
  refreshesUnderLock: () => number;
  writesUnderLock: () => number;
  disposed: () => boolean;
}

export interface EffectsOptions {
  session?: FakeSession;
  files?: Record<string, string>;
  overrides?: Partial<CliEffects>;
}

export interface FakeEffects {
  effects: CliEffects;
  initCalls: () => number;
  openCalls: () => number;
  resolveCalls: () => number;
  editorPaths: string[];
}

const fakeNow = new Date('2026-10-20T12:00:00.000Z');

export const ticketIdOf = (raw: string): TicketId => {
  const parsed = parseTicketId(raw);

  invariant(parsed.ok, `Test ID ${raw} is invalid.`);

  return parsed.value;
};

export const projectNameOf = (raw: string): ProjectName => {
  const parsed = parseProjectName(raw);

  invariant(parsed.ok, `Test project ${raw} is invalid.`);

  return parsed.value;
};

export const makeTicket = (
  id: string,
  overrides: Partial<Omit<CliTicket, 'id'>> = {},
): CliTicket => ({
  id: ticketIdOf(id),
  path: `/store/demo/${id}-slug.md`,
  hash: `hash-${id}`,
  error: null,
  frontMatter: {
    kind: 'task',
    title: 'A title',
    project: projectNameOf('demo'),
    blockedBy: [],
    status: 'open',
  },
  body: 'A body\n',
  ...overrides,
});

export const makeFact = (fields: Record<string, unknown>): Fact => {
  const parsed = parseFactLine(
    JSON.stringify({
      version: 1,
      ticket: 'demo-3467',
      at: '2026-10-20T11:00:00.000Z',
      machine: 'laptop',
      ...fields,
    }),
  );

  invariant(parsed.ok, 'The test fact should parse.');

  return parsed.value;
};

export const makeSession = (options: SessionOptions = {}): FakeSession => {
  const tickets = new Map((options.tickets ?? []).map((ticket) => [ticket.id, ticket]));
  const writes: FakeWrite[] = [];
  const creates: FakeCreate[] = [];
  const facts = [...(options.facts ?? [])];
  const appends: { machine: string; fact: Fact }[] = [];
  const listOptions: { includeArchived: boolean }[] = [];
  let refreshCount = 0;
  let lockCount = 0;
  let releaseCount = 0;
  let lockedRefreshCount = 0;
  let lockedWriteCount = 0;

  const countLockedWrite = (): void => {
    if (lockCount > releaseCount) {
      lockedWriteCount += 1;
    }
  };

  let isDisposed = false;

  const session: CliSession = {
    refresh: () => {
      refreshCount += 1;

      if (lockCount > releaseCount) {
        lockedRefreshCount += 1;
      }

      return Promise.resolve({ ok: true, value: undefined });
    },
    getTicket: (id) => {
      const ticket = tickets.get(id);

      if (ticket === undefined) {
        return { ok: false, reason: { message: `Ticket ${id} is not in the cache.` } };
      }

      return { ok: true, value: ticket };
    },
    findTicketPath: (id) => {
      const ticket = tickets.get(id);

      if (ticket === undefined) {
        return { ok: false, reason: { message: `Ticket ${id} is not in the cache.` } };
      }

      return { ok: true, value: ticket.path };
    },
    listTickets: (listing) => {
      listOptions.push(listing);

      return [...tickets.values()].filter(
        (ticket) => listing.includeArchived || ticket.frontMatter.archived === undefined,
      );
    },
    listErrors: () => options.errors ?? [],
    listFacts: (ticketIds) =>
      facts.filter((fact) => ticketIds === undefined || ticketIds.includes(fact.ticket)),
    lockStore: () => {
      lockCount += 1;

      return Promise.resolve({
        ok: true,
        value: {
          release: () => {
            releaseCount += 1;

            return Promise.resolve();
          },
        },
      });
    },
    appendFact: (machine, fact) => {
      appends.push({ machine, fact });
      facts.push(fact);

      return Promise.resolve({
        ok: true,
        value: { path: `/store/facts/${machine}/2026-10.jsonl` },
      });
    },
    createTicketFile: (project, title, text) => {
      creates.push({ project, title, text });
      countLockedWrite();

      const created = options.created ?? makeTicket('demo-3467');

      tickets.set(created.id, created);

      return Promise.resolve({
        ok: true,
        value: { id: created.id, path: created.path, hash: created.hash },
      });
    },
    writeTicketFile: (path, expectedHash, text) => {
      writes.push({ path, expectedHash, text });
      countLockedWrite();

      return Promise.resolve({ ok: true, value: { hash: 'new-hash' } });
    },
    [Symbol.dispose]: () => {
      isDisposed = true;
    },
    ...options.overrides,
  };

  return {
    session,
    writes,
    creates,
    appends,
    listOptions,
    refreshes: () => refreshCount,
    locks: () => lockCount,
    releases: () => releaseCount,
    refreshesUnderLock: () => lockedRefreshCount,
    writesUnderLock: () => lockedWriteCount,
    disposed: () => isDisposed,
  };
};

export const makeEffects = (options: EffectsOptions = {}): FakeEffects => {
  const fakeSession = options.session ?? makeSession();
  const editorPaths: string[] = [];
  let initCount = 0;
  let openCount = 0;
  let resolveCount = 0;

  const effects: CliEffects = {
    initStore: () => {
      initCount += 1;

      return Promise.resolve({ ok: true, value: { store: '/store', created: true } });
    },
    openSession: () => {
      openCount += 1;

      return Promise.resolve({ ok: true, value: fakeSession.session });
    },
    resolveProject: () => {
      resolveCount += 1;

      return Promise.resolve({ ok: true, value: projectNameOf('demo') });
    },
    readTextFile: (path) => Promise.resolve(options.files?.[path]),
    runEditor: (path) => {
      editorPaths.push(path);

      return Promise.resolve({ ok: true, value: undefined });
    },
    resolveMachine: () => Promise.resolve({ ok: true, value: 'laptop' }),
    now: () => fakeNow,
    ...options.overrides,
  };

  return {
    effects,
    initCalls: () => initCount,
    openCalls: () => openCount,
    resolveCalls: () => resolveCount,
    editorPaths,
  };
};

export const failed = (message: string): Promise<Result<never, { message: string }>> =>
  Promise.resolve({ ok: false, reason: { message } });

export const successOf = (result: CommandResult): { json: unknown; text: string } => {
  invariant(result.ok, 'The command should succeed.');

  return result.value;
};

export const failureOf = (result: CommandResult): CliFailure => {
  invariant(!result.ok, 'The command should fail.');

  return result.reason;
};
