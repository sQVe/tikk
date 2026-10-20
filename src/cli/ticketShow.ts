import { deriveTaskState } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket, taskView, ticketText, ticketView } from './ticketView.ts';

const showView = ({ effects, session }: CommandInput, ticket: CliTicket): unknown => {
  if (ticket.frontMatter.kind !== 'task') {
    return ticketView(ticket, true);
  }

  const facts = session.listFacts([ticket.id]);
  const { state, claim } = deriveTaskState(ticket, facts, effects.now());

  return taskView(ticket, state, claim);
};

export const ticketShow = (input: CommandInput): CommandResult => {
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

  return {
    ok: true,
    value: { json: showView(input, ticket.value), text: ticketText(ticket.value) },
  };
};
