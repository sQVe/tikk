import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket, ticketText, ticketView } from './ticketView.ts';

export const ticketShow = ({ args, session }: CommandInput): CommandResult => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk show <id> [--json]');
  }

  const ticket = findTicket(session, rawId);

  if (!ticket.ok) {
    return ticket;
  }

  return {
    ok: true,
    value: { json: ticketView(ticket.value, true), text: ticketText(ticket.value) },
  };
};
