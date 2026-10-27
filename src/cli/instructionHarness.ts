import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import type { CliEffects, CliSession, CommandInput, CommandResult } from './cliEffects.ts';
import {
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
  successOf,
  ticketIdOf,
} from './cliHarness.ts';
import type { FakeSession } from './cliHarness.ts';

export type Command = (input: CommandInput) => Promise<CommandResult>;

export interface RunOptions {
  facts?: Fact[];
  tickets?: ReturnType<typeof makeTicket>[];
  effects?: Partial<CliEffects>;
  session?: Parameters<typeof makeSession>[0];
}

interface SideEffects {
  appends: FakeSession['appends'];
  writes: FakeSession['writes'];
  creates: FakeSession['creates'];
  lockHeld: boolean;
}

export interface Flow {
  fakeSession: FakeSession;
  step: (command: Command, args: string[]) => Promise<CommandResult>;
}

export const parentSlice = makeKindTicket('demo-4789', 'slice');

export const instruction = makeTicket('demo-3467', {
  frontMatter: { ...makeTicket('demo-3467').frontMatter, parent: ticketIdOf('demo-4789') },
});

const activeLease = '2026-10-20T13:00:00.000Z';

export const claimBy = (holder: string): Fact =>
  makeFact({ kind: 'claim', holder, leaseEnd: activeLease });

export const submissionItem = '5ab0000000a1';

export const submittedBy = (holder: string): Fact =>
  makeFact({
    kind: 'log',
    type: 'submitted',
    text: '',
    holder,
    item: submissionItem,
    at: '2026-10-20T11:30:00.000Z',
  });

export const accepted = makeFact({
  kind: 'accept',
  item: submissionItem,
  at: '2026-10-20T11:45:00.000Z',
});

// A refusal that comes before the lock reports its own error, not `locked`.
export const lockRefused: Partial<CliSession> = {
  lockStore: () =>
    Promise.resolve({
      ok: false,
      reason: { kind: 'locked', message: 'The store is locked by process 42.' },
    }),
};

export const run = async (
  command: Command,
  args: string[],
  options: RunOptions = {},
): Promise<{ fakeSession: FakeSession; result: CommandResult }> => {
  const fakeSession = makeSession({
    tickets: options.tickets ?? [parentSlice, instruction],
    facts: options.facts ?? [],
    ...options.session,
  });

  const { effects } = makeEffects({
    session: fakeSession,
    ...(options.effects === undefined ? {} : { overrides: options.effects }),
  });

  const result = await command({ args, json: true, effects, session: fakeSession.session });

  return { fakeSession, result };
};

// Commands that run one after another on the same store, as separate tikk calls would.
export const openFlow = (options: RunOptions = {}): Flow => {
  const fakeSession = makeSession({
    tickets: options.tickets ?? [parentSlice, instruction],
    facts: options.facts ?? [],
    ...options.session,
  });

  const { effects } = makeEffects({
    session: fakeSession,
    ...(options.effects === undefined ? {} : { overrides: options.effects }),
  });

  const step = async (command: Command, args: string[]): Promise<CommandResult> => {
    await fakeSession.session.refresh();

    return command({ args, json: true, effects, session: fakeSession.session });
  };

  return { fakeSession, step };
};

// The item a question or a submission printed.
export const itemOf = (result: CommandResult): string => {
  const { json } = successOf(result);

  invariant(typeof json === 'object' && json !== null && 'item' in json, 'Expected an item.');
  invariant(typeof json.item === 'string', 'Expected a string item.');

  return json.item;
};

// What a refused command must leave behind.
export const noSideEffects: SideEffects = { appends: [], writes: [], creates: [], lockHeld: false };

export const sideEffectsOf = (fakeSession: FakeSession): SideEffects => ({
  appends: fakeSession.appends,
  writes: fakeSession.writes,
  creates: fakeSession.creates,
  lockHeld: fakeSession.lockHeld(),
});

export const orphan = (): ReturnType<typeof makeTicket> => ({
  ...instruction,
  frontMatter: {
    ...instruction.frontMatter,
    parent: ticketIdOf('demo-4789'),
    blockedBy: [ticketIdOf('demo-6789')],
  },
});

export const parentOnly = (): ReturnType<typeof makeTicket> => ({
  ...instruction,
  frontMatter: { ...instruction.frontMatter, parent: ticketIdOf('demo-4789') },
});

export const blockedOnly = (): ReturnType<typeof makeTicket> => ({
  ...instruction,
  frontMatter: { ...instruction.frontMatter, blockedBy: [ticketIdOf('demo-6789')] },
});
