import {
  forceOptions,
  invalidArguments,
  parseCommandArguments,
  readForce,
} from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict, refuseFileErrors, withLockedTicket } from './taskLock.ts';
import { checkSessionTree, writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh, showOutput } from './ticketView.ts';

const closeLocked = async (
  input: CommandInput,
  ticket: CliTicket,
  forced: string | undefined,
): Promise<CommandResult> => {
  const { frontMatter } = ticket;

  if (frontMatter.kind !== 'issue') {
    return invalidArguments(
      `Ticket ${ticket.id} is not an issue: its kind is ${frontMatter.kind}, and only an issue closes.`,
    );
  }

  if (frontMatter.status === 'closed') {
    return showOutput(input.session, input.effects.now(), ticket);
  }

  if (frontMatter.status === 'canceled') {
    return conflict(`Issue ${ticket.id} is canceled, so it cannot be closed.`);
  }

  const tree = forced === undefined ? checkSessionTree(input.session, frontMatter) : undefined;

  if (tree !== undefined && !tree.ok) {
    return tree;
  }

  const closed = { ...frontMatter, status: 'closed' as const };

  const written = await writeTicketWithStatus(input, {
    expectedHash: ticket.hash,
    ticket,
    frontMatter: closed,
    forced,
  });

  if (!written.ok) {
    return written;
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
};

export const ticketClose = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, forceOptions);

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk close <id> [--force --reason <text>] [--json]');
  }

  const forced = readForce(parsed.value.values);

  if (!forced.ok) {
    return forced;
  }

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    closeLocked(input, ticket, forced.value),
  );
};
