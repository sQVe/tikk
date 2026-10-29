import type { Fact } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { factDetailOf, factKindOf, readTicketFacts } from './ticketFacts.ts';
import { findTicket } from './ticketView.ts';

const firstLineOf = (fact: Fact): string => factDetailOf(fact).split('\n')[0] ?? '';

const lineOf = (fact: Fact): string => `${fact.at}  ${factKindOf(fact)}  ${firstLineOf(fact)}\n`;

export const historyCommand = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk history <id> [--json]');
  }

  const ticket = findTicket(input.session, rawId);

  if (!ticket.ok) {
    return ticket;
  }

  const facts = await readTicketFacts(input.session, ticket.value.id);

  if (!facts.ok) {
    return facts;
  }

  return {
    ok: true,
    value: {
      json: { id: ticket.value.id, facts: facts.value },
      text: facts.value.map(lineOf).join(''),
    },
  };
};
