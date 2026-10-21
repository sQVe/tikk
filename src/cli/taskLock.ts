import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket } from './ticketView.ts';

export interface LockedTask {
  task: CliTicket;
  facts: Fact[];
  now: Date;
}

type FileErrors = 'refuse' | 'allow';

interface LockPolicy {
  fileErrors: FileErrors;
  requireTask: boolean;
}

export const conflict = (message: string): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'conflict', message },
});

export const fileErrorFailure = (ticket: CliTicket): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'parseError', message: `${ticket.path} has an error: ${ticket.error}` },
});

export const refuseFileErrors: LockPolicy = { fileErrors: 'refuse', requireTask: false };

const loadTicket = async (
  input: CommandInput,
  rawId: string,
  policy: LockPolicy,
): Promise<Result<CliTicket, CliFailure>> => {
  const refreshed = await input.session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
  }

  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  const ticket = found.value;

  if (policy.requireTask && ticket.frontMatter.kind !== 'task') {
    return invalidArguments(
      `Ticket ${ticket.id} is not a task: its kind is ${ticket.frontMatter.kind}.`,
    );
  }

  // The cache keeps the last good front matter of a broken file, which a change must not use.
  if (policy.fileErrors === 'refuse' && ticket.error !== null) {
    return fileErrorFailure(ticket);
  }

  return { ok: true, value: ticket };
};

const runUnderStoreLock = async (
  input: CommandInput,
  work: () => Promise<CommandResult>,
): Promise<CommandResult> => {
  const lock = await input.session.lockStore();

  if (!lock.ok) {
    const code = lock.reason.kind === 'locked' ? 'locked' : 'storeError';

    return { ok: false, reason: { code, message: lock.reason.message } };
  }

  try {
    return await work();
  } finally {
    await lock.value.release();
  }
};

// Every write runs under the store lock. The work refreshes the cache after it takes the lock, so
// its checks see every earlier write. A write that succeeds schedules a background sync once the
// lock is free.
export const withStoreLock = async (
  input: CommandInput,
  work: () => Promise<CommandResult>,
): Promise<CommandResult> => {
  const result = await runUnderStoreLock(input, work);

  if (result.ok) {
    await input.effects.scheduleSync();
  }

  return result;
};

export const withLockedTicket = (
  input: CommandInput,
  rawId: string,
  policy: LockPolicy,
  work: (ticket: CliTicket) => Promise<CommandResult>,
): Promise<CommandResult> =>
  withStoreLock(input, async () => {
    const loaded = await loadTicket(input, rawId, policy);

    if (!loaded.ok) {
      return loaded;
    }

    return work(loaded.value);
  });

const loadTask = async (
  input: CommandInput,
  rawId: string,
  fileErrors: FileErrors,
): Promise<Result<LockedTask, CliFailure>> => {
  const loaded = await loadTicket(input, rawId, { fileErrors, requireTask: true });

  if (!loaded.ok) {
    return loaded;
  }

  const facts = await input.session.listStateFacts([loaded.value.id]);

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  return { ok: true, value: { task: loaded.value, facts: facts.value, now: input.effects.now() } };
};

export const withLockedTask = (
  input: CommandInput,
  rawId: string,
  fileErrors: FileErrors,
  work: (locked: LockedTask) => Promise<CommandResult>,
): Promise<CommandResult> =>
  withStoreLock(input, async () => {
    const loaded = await loadTask(input, rawId, fileErrors);

    if (!loaded.ok) {
      return loaded;
    }

    return work(loaded.value);
  });

// The fetch runs before the lock because writers wait for the lock only five seconds. The merge runs
// under the lock, so the checks of the work see claims made on other machines.
export const withFetchedTask = async (
  input: CommandInput,
  rawId: string,
  fileErrors: FileErrors,
  work: (locked: LockedTask) => Promise<CommandResult>,
): Promise<CommandResult> => {
  await input.effects.fetchRemote();

  return withStoreLock(input, async () => {
    await input.effects.mergeFetched();

    const loaded = await loadTask(input, rawId, fileErrors);

    if (!loaded.ok) {
      return loaded;
    }

    return work(loaded.value);
  });
};
