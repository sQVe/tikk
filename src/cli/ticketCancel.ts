import { deriveTaskState } from '../fact/fact.ts';
import { serializeTicketFile } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { conflict, withLockedTask } from './taskLock.ts';
import type { LockedTask } from './taskLock.ts';
import { taskOutput } from './ticketView.ts';

const cancelLocked = async (input: CommandInput, locked: LockedTask): Promise<CommandResult> => {
  const { task } = locked;
  const { state } = deriveTaskState(task, locked.facts, locked.now);

  if (state === 'canceled') {
    return taskOutput(task, state, null);
  }

  if (state === 'done') {
    return conflict(`Task ${task.id} is done, so it cannot be canceled.`);
  }

  const frontMatter = { ...task.frontMatter, status: 'canceled' as const };
  const text = serializeTicketFile({ frontMatter, body: task.body });
  const written = await input.session.writeTicketFile(task.path, task.hash, text);

  if (!written.ok) {
    const code = written.reason.kind === 'changedOnDisk' ? 'changedOnDisk' : 'storeError';

    return { ok: false, reason: { code, message: written.reason.message } };
  }

  return taskOutput({ ...task, hash: written.value.hash, frontMatter }, 'canceled', null);
};

export const ticketCancel = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk cancel <id> [--json]');
  }

  return withLockedTask(input, rawId, 'refuse', (locked) => cancelLocked(input, locked));
};
