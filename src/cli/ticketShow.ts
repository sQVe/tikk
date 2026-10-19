import { parseTicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { ticketText, ticketView } from './ticketView.ts';

export const ticketShow = ({ args, session }: CommandInput): CommandResult => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk show <id> [--json]');
  }

  const id = parseTicketId(rawId);
  const notFound = { code: 'notFound', message: `Ticket ${rawId} does not exist.` } as const;

  if (!id.ok) {
    return { ok: false, reason: notFound };
  }

  const ticket = session.getTicket(id.value);

  if (!ticket.ok) {
    return { ok: false, reason: notFound };
  }

  return {
    ok: true,
    value: { json: ticketView(ticket.value, true), text: ticketText(ticket.value) },
  };
};
