import { selectReady } from '../fact/fact.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { ticketView } from './ticketView.ts';

type Selection = ReturnType<typeof selectReady<CliTicket>>;
type Skipped = Selection['skipped'][number];

const skippedView = (item: Skipped): Record<string, unknown> => ({
  id: item.ticket.id,
  title: item.ticket.frontMatter.title,
  reason: item.reason,
  ...(item.blockers === undefined ? {} : { blockers: item.blockers }),
  ...(item.holder === undefined ? {} : { holder: item.holder }),
  ...(item.leaseEnd === undefined ? {} : { leaseEnd: item.leaseEnd }),
});

const skippedDetails = (item: Skipped): string => {
  if (item.blockers !== undefined) {
    return item.blockers.map((blocker) => `${blocker.id} (${blocker.state})`).join(', ');
  }

  if (item.holder !== undefined) {
    return `${item.holder} until ${item.leaseEnd ?? ''}`;
  }

  return '';
};

const readyText = (selection: Selection): string => {
  const candidateLines = selection.candidates.map(
    ({ ticket, state }) => `${ticket.id}  ${state}  ${ticket.frontMatter.title}\n`,
  );

  const skippedLines = selection.skipped.map((item) => {
    const line = `skipped: ${item.ticket.id}  ${item.reason}  ${skippedDetails(item)}`;

    return `${line.trimEnd()}\n`;
  });

  return [...candidateLines, ...skippedLines].join('');
};

export const readyCommand = ({ args, effects, session }: CommandInput): CommandResult => {
  const parsed = parseCommandArguments(args, {
    project: { type: 'string' },
    parent: { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk ready [--project <p>] [--parent <id>] [--json]');
  }

  const project = stringValue(parsed.value.values, 'project');
  const parent = stringValue(parsed.value.values, 'parent');

  // Archived tickets stay in the list so a blocker that was archived is not reported as missing.
  const tickets = session.listTickets({ includeArchived: true });

  const selection = selectReady(tickets, session.listFacts(), effects.now(), {
    ...(project === undefined ? {} : { project }),
    ...(parent === undefined ? {} : { parent }),
  });

  const candidates = selection.candidates.map(({ ticket, state }) => ({
    ...ticketView(ticket, false),
    state,
  }));

  return {
    ok: true,
    value: {
      json: { candidates, skipped: selection.skipped.map(skippedView) },
      text: readyText(selection),
    },
  };
};
