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

export const conflict = (message: string): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'conflict', message },
});

export const fileErrorFailure = (ticket: CliTicket): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'parseError', message: `${ticket.path} has an error: ${ticket.error}` },
});

const loadTask = async (
  input: CommandInput,
  rawId: string,
  fileErrors: FileErrors,
): Promise<Result<LockedTask, CliFailure>> => {
  const refreshed = await input.session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
  }

  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  const task = found.value;

  if (task.frontMatter.kind !== 'task') {
    return invalidArguments(`Ticket ${task.id} is a ${task.frontMatter.kind}, not a task.`);
  }

  // The cache keeps the last good front matter of a broken file, which a state change must not use.
  if (fileErrors === 'refuse' && task.error !== null) {
    return fileErrorFailure(task);
  }

  const facts = input.session.listFacts([task.id]);

  return { ok: true, value: { task, facts, now: input.effects.now() } };
};

// Every write runs under the store lock. The work refreshes the cache after it takes the lock, so
// its checks see every earlier write.
export const withStoreLock = async (
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
