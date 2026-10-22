import { selectNeeds } from '../fact/fact.ts';
import type { NeedItem } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { problemLines, reconcileBeforeRead } from './prReconcile.ts';

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
  ...(item.openTasks === undefined ? {} : { openTasks: item.openTasks }),
  ...(item.ticket.error === null ? {} : { parseError: item.ticket.path }),
});

const itemLine = (item: NeedItem<CliTicket>): string => {
  const { ticket } = item;
  const line = `${ticket.id}  ${item.reason}  ${shortAge(item.ageSeconds)}  ${ticket.frontMatter.title}`;
  const tasks = item.openTasks === undefined ? '' : `  ${item.openTasks.join(' ')}`;
  const suffix = ticket.error === null ? '' : `  parseError ${ticket.path}`;

  return `${line}${tasks}${suffix}\n`;
};

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

  const reconciled = await reconcileBeforeRead({ effects, session });

  if (!reconciled.ok) {
    return reconciled;
  }

  const tickets = session.listTickets({ includeArchived: true });
  const facts = await session.listFacts();

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  const items = selectNeeds(tickets, facts.value, effects.now());

  return {
    ok: true,
    value: {
      json: { items: items.map(itemView), reconcileProblems: reconciled.value },
      text: items.map(itemLine).join('') + problemLines(reconciled.value),
    },
  };
};
