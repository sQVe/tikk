import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket, showOutput } from './ticketView.ts';

export const ticketShow = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk show <id> [--json]');
  }

  const ticket = findTicket(input.session, rawId);

  if (!ticket.ok) {
    return ticket;
  }

  return showOutput(input.session, input.effects.now(), ticket.value);
};
