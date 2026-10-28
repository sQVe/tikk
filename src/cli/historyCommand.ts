import { selectTicketHistory } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket, storeFailure } from './ticketView.ts';

const kindOf = (fact: Fact): string => ('type' in fact ? `${fact.kind}/${fact.type}` : fact.kind);

const detailOf = (fact: Fact): string => {
  if ('text' in fact && fact.text !== undefined) {
    return fact.text;
  }

  if ('reason' in fact) {
    return fact.reason;
  }

  return '';
};

const lineOf = (fact: Fact): string => {
  const firstLine = detailOf(fact).split('\n')[0] ?? '';

  return `${fact.at}  ${kindOf(fact)}  ${firstLine}\n`;
};

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

  const facts = await input.session.listFacts([ticket.value.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const selected = selectTicketHistory(facts.value, ticket.value.id);

  return {
    ok: true,
    value: {
      json: { id: ticket.value.id, facts: selected },
      text: selected.map(lineOf).join(''),
    },
  };
};
