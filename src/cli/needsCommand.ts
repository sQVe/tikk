import { selectNeeds } from '../fact/fact.ts';
import type { NeedItem } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';

const secondsPerMinute = 60;
const secondsPerHour = 3600;
const secondsPerDay = 86_400;

const shortAge = (ageSeconds: number): string => {
  if (ageSeconds < secondsPerMinute) {
    return `${ageSeconds}s`;
  }

  if (ageSeconds < secondsPerHour) {
    return `${Math.floor(ageSeconds / secondsPerMinute)}m`;
  }

  if (ageSeconds < secondsPerDay) {
    return `${Math.floor(ageSeconds / secondsPerHour)}h`;
  }

  return `${Math.floor(ageSeconds / secondsPerDay)}d`;
};

const itemView = (item: NeedItem<CliTicket>): Record<string, unknown> => ({
  id: item.ticket.id,
  title: item.ticket.frontMatter.title,
  reason: item.reason,
  since: item.since,
  ageSeconds: item.ageSeconds,
  ...(item.holder === undefined ? {} : { holder: item.holder }),
});

const itemLine = (item: NeedItem<CliTicket>): string =>
  `${item.ticket.id}  ${item.reason}  ${shortAge(item.ageSeconds)}  ${item.ticket.frontMatter.title}\n`;

export const needsCommand = async ({
  args,
  effects,
  session,
}: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk needs [--json]');
  }

  const tickets = session.listTickets({ includeArchived: false });
  const readable = tickets.filter((ticket) => ticket.error === null);
  const facts = await session.listFacts();

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  const items = selectNeeds(readable, facts.value, effects.now());

  return {
    ok: true,
    value: { json: { items: items.map(itemView) }, text: items.map(itemLine).join('') },
  };
};
