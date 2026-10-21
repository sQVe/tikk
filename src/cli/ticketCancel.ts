import { deriveTaskState } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { serializeTicketFile } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict } from './taskLock.ts';
import { withLockedTicket, writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh, showOutput, storeFailure, taskOutput } from './ticketView.ts';

const writeCanceled = async (
  input: CommandInput,
  ticket: CliTicket,
): Promise<Result<CliTicket, CliFailure>> => {
  const frontMatter = { ...ticket.frontMatter, status: 'canceled' as const };
  const text = serializeTicketFile({ frontMatter, body: ticket.body });

  const written = await writeTicketWithStatus(input, {
    expectedHash: ticket.hash,
    text,
    status: 'canceled',
    ticket,
  });

  if (!written.ok) {
    return written;
  }

  return { ok: true, value: { ...ticket, hash: written.value.hash, frontMatter } };
};

const cancelTask = async (input: CommandInput, task: CliTicket): Promise<CommandResult> => {
  const now = input.effects.now();
  const facts = await input.session.listStateFacts([task.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const { state } = deriveTaskState(task, facts.value, now);

  if (state === 'canceled') {
    return taskOutput(task, state, null);
  }

  if (state === 'done') {
    return conflict(`Task ${task.id} is done, so it cannot be canceled.`);
  }

  const canceled = await writeCanceled(input, task);

  if (!canceled.ok) {
    return canceled;
  }

  return taskOutput(canceled.value, 'canceled', null);
};

const cancelOther = async (input: CommandInput, ticket: CliTicket): Promise<CommandResult> => {
  const { status } = ticket.frontMatter;
  const now = input.effects.now();

  if (status === 'canceled') {
    return showOutput(input.session, now, ticket);
  }

  if (status === 'closed') {
    return conflict(`Issue ${ticket.id} is closed, so it cannot be canceled.`);
  }

  const canceled = await writeCanceled(input, ticket);

  if (!canceled.ok) {
    return canceled;
  }

  return showAfterRefresh(input.session, now, ticket.id);
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

  return withLockedTicket(input, rawId, (ticket) =>
    ticket.frontMatter.kind === 'task' ? cancelTask(input, ticket) : cancelOther(input, ticket),
  );
};
