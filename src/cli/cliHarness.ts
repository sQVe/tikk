import { parseFactLine } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import { parseProjectName, parseTicketFile, parseTicketId } from '../ticket/ticket.ts';
import type { ProjectName, TicketId } from '../ticket/ticket.ts';
import type { CliEffects, CliFailure, CliSession, CliTicket, CommandResult } from './cliEffects.ts';

interface FakeWrite {
  path: string;
  expectedHash: string;
  text: string;
  underLock: boolean;
}

interface FakeCreate {
  project: string;
  title: string;
  text: string;
  underLock: boolean;
}

export interface SessionOptions {
  tickets?: CliTicket[];
  facts?: Fact[];
  errors?: { path: string; message: string }[];
  folderFiles?: Record<string, string[]>;
  created?: CliTicket;
  readBack?: boolean;
  overrides?: Partial<CliSession>;
}

export interface FakeSession {
  session: CliSession;
  writes: FakeWrite[];
  creates: FakeCreate[];
  appends: { machine: string; fact: Fact }[];
  storedLogs: string[];
  listOptions: { includeArchived: boolean }[];
  lockHeld: () => boolean;
  changeOnDisk: (ticket: CliTicket) => void;
  disposed: () => boolean;
}

export interface EffectsOptions {
  session?: FakeSession;
  files?: Record<string, string>;
  runGh?: CliEffects['runGh'];
  overrides?: Partial<CliEffects>;
}

export interface FakeEffects {
  effects: CliEffects;
  initCalls: () => number;
  openCalls: () => number;
  resolveCalls: () => number;
  syncCalls: () => number;
  scheduleCalls: () => number;
  remoteUrls: string[];
  editorPaths: string[];
  ghCalls: string[][];
}

interface FakePullRequest {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  base?: string;
  head?: string;
  mergeCommit?: string;
  compare?: string;
  error?: string;
}

const fakeNow = new Date('2026-10-20T12:00:00.000Z');

const itemIdLength = 12;

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
    kind: 'instruction',
    title: 'A title',
    project: projectNameOf('demo'),
    blockedBy: [],
    discoveredFrom: [],
    related: [],
    status: 'open',
  },
  body: 'A body\n',
  ...overrides,
});

export const makeKindTicket = (
  id: string,
  kind: CliTicket['frontMatter']['kind'],
  status: CliTicket['frontMatter']['status'] = 'open',
): CliTicket => {
  const base = makeTicket(id);

  return makeTicket(id, { frontMatter: { ...base.frontMatter, kind, status } });
};

const readBack = (text: string): CliTicket => {
  const parsed = parseTicketFile(text);

  invariant(parsed.ok, 'The created text should parse.');

  return makeTicket('demo-3467', {
    frontMatter: parsed.value.frontMatter,
    body: parsed.value.body,
  });
};

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

// A write that parses replaces the ticket at its path on disk, so a refresh shows it.
const applyWrite = (disk: Map<TicketId, CliTicket>, path: string, text: string): void => {
  const parsed = parseTicketFile(text);
  const ticket = [...disk.values()].find((candidate) => candidate.path === path);

  if (!parsed.ok || ticket === undefined) {
    return;
  }

  disk.set(ticket.id, { ...ticket, hash: 'new-hash', ...parsed.value });
};

export const makeSession = (options: SessionOptions = {}): FakeSession => {
  // Reads see the cache. A write changes the disk, and only a refresh copies the disk to the cache.
  const disk = new Map((options.tickets ?? []).map((ticket) => [ticket.id, ticket]));
  const diskFacts = [...(options.facts ?? [])];
  const tickets = new Map(disk);
  const facts = [...diskFacts];
  const writes: FakeWrite[] = [];
  const creates: FakeCreate[] = [];
  const appends: { machine: string; fact: Fact }[] = [];
  const storedLogs: string[] = [];
  const listOptions: { includeArchived: boolean }[] = [];
  let isLocked = false;
  let isDisposed = false;

  const takeLock: CliSession['lockStore'] = () => {
    isLocked = true;

    return Promise.resolve({
      ok: true,
      value: {
        release: () => {
          isLocked = false;

          return Promise.resolve();
        },
      },
    });
  };

  const session: CliSession = {
    refresh: () => {
      tickets.clear();

      for (const [id, ticket] of disk) {
        tickets.set(id, ticket);
      }

      facts.splice(0, facts.length, ...diskFacts);

      return Promise.resolve({ ok: true, value: undefined });
    },
    getTicket: (id) => {
      const ticket = tickets.get(id);

      if (ticket === undefined) {
        return {
          ok: false,
          reason: { kind: 'notFound', message: `Ticket ${id} is not in the cache.` },
        };
      }

      return { ok: true, value: ticket };
    },
    findTicketPath: (id) => {
      const ticket = tickets.get(id);

      if (ticket === undefined) {
        return {
          ok: false,
          reason: { kind: 'notFound', message: `Ticket ${id} is not in the cache.` },
        };
      }

      return { ok: true, value: ticket.path };
    },
    listTickets: (listing) => {
      listOptions.push(listing);

      const listed = [...tickets.values()].filter(
        (ticket) => listing.includeArchived || ticket.frontMatter.archived === undefined,
      );

      return { ok: true, value: listed };
    },
    mayHaveArchiveWork: () => ({ ok: true, value: true }),
    listTicketOutlines: () => ({
      ok: true,
      value: [...tickets.values()].filter((ticket) => ticket.error === null),
    }),
    listErrors: () => ({ ok: true, value: options.errors ?? [] }),
    listTicketFolderFiles: (_project, id) =>
      Promise.resolve({ ok: true, value: options.folderFiles?.[id] ?? [] }),
    designFilePath: (project, id) => `/store/tickets/${project}/${id}/design.md`,
    listFacts: (ticketIds) =>
      Promise.resolve({
        ok: true,
        value: facts.filter((fact) => ticketIds === undefined || ticketIds.includes(fact.ticket)),
      }),
    listStateFacts: (ticketIds) =>
      Promise.resolve({
        ok: true,
        value: facts.filter((fact) => ticketIds === undefined || ticketIds.includes(fact.ticket)),
      }),
    listArchiveFacts: () => Promise.resolve({ ok: true, value: [...facts] }),
    lockStore: takeLock,
    tryLockStore: takeLock,
    storeLog: (text) => {
      storedLogs.push(text);

      return Promise.resolve({
        ok: true,
        value: { hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      });
    },
    checkIdUnshared: () => ({ ok: true, value: undefined }),
    appendFact: (machine, fact) => {
      appends.push({ machine, fact });
      diskFacts.push(fact);

      return Promise.resolve({
        ok: true,
        value: { path: `/store/facts/${machine}/2026-10.jsonl` },
      });
    },
    createTicketFile: (project, title, text) => {
      creates.push({ project, title, text, underLock: isLocked });

      const created = options.readBack === true ? readBack(text) : options.created;
      const stored = created ?? makeTicket('demo-3467');

      disk.set(stored.id, stored);

      return Promise.resolve({
        ok: true,
        value: { id: stored.id, path: stored.path, hash: stored.hash },
      });
    },
    writeTicketFile: (path, expectedHash, text) => {
      writes.push({ path, expectedHash, text, underLock: isLocked });
      applyWrite(disk, path, text);

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
    storedLogs,
    listOptions,
    lockHeld: () => isLocked,
    changeOnDisk: (ticket) => {
      disk.set(ticket.id, ticket);
    },
    disposed: () => isDisposed,
  };
};

export const failed = (message: string): Promise<Result<never, { message: string }>> =>
  Promise.resolve({ ok: false, reason: { message } });

const recordGh =
  (calls: string[][], reply: CliEffects['runGh'] | undefined): CliEffects['runGh'] =>
  (args, signal) => {
    calls.push(args);

    return reply === undefined ? failed('gh is not available.') : reply(args, signal);
  };

// A gh that never answers on its own and fails only once its signal aborts.
export const stalledGh: CliEffects['runGh'] = (args, signal) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve({ ok: false, reason: { message: `"gh ${args.join(' ')}" was stopped.` } });
    });
  });

// Runs with every timeout signal aborting as soon as its caller waits.
export const withExpiredTimeouts = async <Value>(run: () => Promise<Value>): Promise<Value> => {
  const original = AbortSignal.timeout.bind(AbortSignal);

  AbortSignal.timeout = () => {
    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 0);

    return controller.signal;
  };

  try {
    return await run();
  } finally {
    AbortSignal.timeout = original;
  }
};

export const makeEffects = (options: EffectsOptions = {}): FakeEffects => {
  const fakeSession = options.session ?? makeSession();
  const editorPaths: string[] = [];
  const remoteUrls: string[] = [];
  const ghCalls: string[][] = [];
  let syncCount = 0;
  let scheduleCount = 0;
  let initCount = 0;
  let openCount = 0;
  let resolveCount = 0;
  let itemCount = 0;

  const effects: CliEffects = {
    initStore: () => {
      initCount += 1;

      return Promise.resolve({ ok: true, value: { store: '/store', created: true } });
    },
    initRemoteStore: (url) => {
      remoteUrls.push(url);

      return Promise.resolve({
        ok: true,
        value: { store: '/store', created: true, remote: url, pushed: true },
      });
    },
    syncStore: () => {
      syncCount += 1;

      return Promise.resolve({
        ok: true,
        value: {
          committed: true,
          pending: [],
          aliases: [],
          remote: true,
          fetched: true,
          merged: true,
          pushed: true,
        },
      });
    },
    runBackgroundSync: () => Promise.resolve(),
    scheduleSync: () => {
      scheduleCount += 1;

      return Promise.resolve();
    },
    fetchRemote: () => Promise.resolve(),
    mergeFetched: () => Promise.resolve(),
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
    runGh: recordGh(ghCalls, options.runGh),
    now: () => fakeNow,
    newItemId: () => {
      itemCount += 1;

      return String(itemCount).padStart(itemIdLength, '0');
    },
    ...options.overrides,
  };

  return {
    effects,
    initCalls: () => initCount,
    openCalls: () => openCount,
    resolveCalls: () => resolveCount,
    syncCalls: () => syncCount,
    scheduleCalls: () => scheduleCount,
    remoteUrls,
    editorPaths,
    ghCalls,
  };
};

export const successOf = (result: CommandResult): { json: unknown; text: string } => {
  invariant(result.ok, 'The command should succeed.');

  return result.value;
};

export const failureOf = (result: CommandResult): CliFailure => {
  invariant(!result.ok, 'The command should fail.');

  return result.reason;
};

const ghOutput = (value: unknown): Promise<Result<string, { message: string }>> =>
  Promise.resolve({ ok: true, value: JSON.stringify(value) });

const mergeCommitOf = (pullRequest: FakePullRequest): { oid: string } | null =>
  pullRequest.mergeCommit === undefined ? null : { oid: pullRequest.mergeCommit };

const viewPullRequest = (
  pullRequest: FakePullRequest | undefined,
  number: number,
  trunk: string,
): Promise<Result<string, { message: string }>> => {
  if (pullRequest === undefined || pullRequest.error !== undefined) {
    return failed(pullRequest?.error ?? `no pull request ${number}`);
  }

  return ghOutput({
    number,
    state: pullRequest.state,
    baseRefName: pullRequest.base ?? trunk,
    headRefOid: pullRequest.head ?? 'head1',
    mergeCommit: mergeCommitOf(pullRequest),
  });
};

// Answers `gh pr view`, `gh repo view`, and `gh api` for pull requests keyed by number.
export const fakeGh =
  (pullRequests: Record<number, FakePullRequest>, trunk = 'main'): CliEffects['runGh'] =>
  (args) => {
    if (args[0] === 'repo') {
      return ghOutput({ defaultBranchRef: { name: trunk } });
    }

    if (args[0] === 'api') {
      const mergeCommit = args[1]?.split('...').at(-1);
      const match = Object.values(pullRequests).find((pr) => pr.mergeCommit === mergeCommit);

      return Promise.resolve({ ok: true, value: `${match?.compare ?? 'ahead'}\n` });
    }

    const number = Number(args[2]);

    return viewPullRequest(pullRequests[number], number, trunk);
  };
