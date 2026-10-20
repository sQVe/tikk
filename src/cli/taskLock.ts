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

export const conflict = (message: string): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'conflict', message },
});

const loadTask = async (
  input: CommandInput,
  rawId: string,
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

  const facts = input.session.listFacts([task.id]);

  return { ok: true, value: { task, facts, now: input.effects.now() } };
};

// The cache refresh runs after the lock is taken, so the state check sees every earlier write.
export const withLockedTask = async (
  input: CommandInput,
  rawId: string,
  work: (locked: LockedTask) => Promise<CommandResult>,
): Promise<CommandResult> => {
  const lock = await input.session.lockStore();

  if (!lock.ok) {
    const code = lock.reason.kind === 'locked' ? 'locked' : 'storeError';

    return { ok: false, reason: { code, message: lock.reason.message } };
  }

  try {
    const loaded = await loadTask(input, rawId);

    if (!loaded.ok) {
      return loaded;
    }

    return await work(loaded.value);
  } finally {
    await lock.value.release();
  }
};
