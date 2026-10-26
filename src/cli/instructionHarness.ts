import type { Fact } from '../fact/fact.ts';
import type { CliEffects, CliSession, CommandInput, CommandResult } from './cliEffects.ts';
import {
  makeEffects,
  makeFact,
  makeKindTicket,
  makeSession,
  makeTicket,
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

export const parentSlice = makeKindTicket('demo-4789', 'slice');

export const instruction = makeTicket('demo-3467', {
  frontMatter: { ...makeTicket('demo-3467').frontMatter, parent: ticketIdOf('demo-4789') },
});

const activeLease = '2026-10-20T13:00:00.000Z';

export const claimBy = (holder: string): Fact =>
  makeFact({ kind: 'claim', holder, leaseEnd: activeLease });

export const submittedBy = (holder: string): Fact =>
  makeFact({ kind: 'log', type: 'submitted', text: '', holder, at: '2026-10-20T11:30:00.000Z' });

export const accepted = makeFact({ kind: 'accept', at: '2026-10-20T11:45:00.000Z' });

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
