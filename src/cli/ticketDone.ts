import { withoutNew } from '../ticket/ticket.ts';
import {
  forceOptions,
  invalidArguments,
  parseCommandArguments,
  readForce,
} from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict, refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { checkSessionTree, writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh, showOutput } from './ticketView.ts';

const doneLocked = async (
  input: CommandInput,
  ticket: CliTicket,
  forced: string | undefined,
): Promise<CommandResult> => {
  const { frontMatter } = ticket;

  if (frontMatter.kind !== 'task') {
    return invalidArguments(
      `Ticket ${ticket.id} is not a task: its kind is ${frontMatter.kind}, and only a task can be done.`,
    );
  }

  if (frontMatter.status === 'done') {
    return showOutput(input.session, input.effects.now(), ticket);
  }

  if (frontMatter.status === 'canceled') {
    return conflict(`Task ${ticket.id} is canceled, so it cannot be done.`);
  }

  const tree = forced === undefined ? checkSessionTree(input.session, frontMatter) : undefined;

  if (tree !== undefined && !tree.ok) {
    return tree;
  }

  const done = withoutNew({ ...frontMatter, status: 'done' as const });

  const written = await writeTicketWithStatus(input, {
    expectedHash: ticket.hash,
    ticket,
    frontMatter: done,
    forced,
  });

  if (!written.ok) {
    return written;
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
};

export const ticketDone = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, forceOptions);

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk done <id> [--force --reason <text>] [--json]');
  }

  const forced = readForce(parsed.value.values);

  if (!forced.ok) {
    return forced;
  }

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    doneLocked(input, ticket, forced.value),
  );
};
