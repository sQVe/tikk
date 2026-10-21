import { serializeTicketFile } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict } from './taskLock.ts';
import { checkSessionTree, withLockedTicket, writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh, showOutput } from './ticketView.ts';

const closeLocked = async (input: CommandInput, ticket: CliTicket): Promise<CommandResult> => {
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

  const tree = checkSessionTree(input.session, frontMatter);

  if (!tree.ok) {
    return tree;
  }

  const closed = { ...frontMatter, status: 'closed' as const };
  const text = serializeTicketFile({ frontMatter: closed, body: ticket.body });

  const written = await writeTicketWithStatus(input, {
    expectedHash: ticket.hash,
    text,
    status: 'closed',
    ticket,
  });

  if (!written.ok) {
    return written;
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
};

export const ticketClose = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk close <id> [--json]');
  }

  return withLockedTicket(input, rawId, (ticket) => closeLocked(input, ticket));
};
