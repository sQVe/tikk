import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { ticketView } from './ticketView.ts';

export const ticketList = ({ args, session }: CommandInput): CommandResult => {
  const parsed = parseCommandArguments(args, {
    project: { type: 'string' },
    archived: { type: 'boolean' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk ls [--project <p>] [--archived] [--json]');
  }

  const project = stringValue(parsed.value.values, 'project');
  const includeArchived = parsed.value.values['archived'] === true;
  const listed = session.listTickets({ includeArchived });

  const tickets = listed.filter(
    (ticket) => project === undefined || ticket.frontMatter.project === project,
  );

  const errors = session.listErrors();

  const lines = tickets.map((ticket) => {
    const { kind, status, title } = ticket.frontMatter;

    return `${ticket.id}  ${kind}  ${status}  ${title}\n`;
  });

  const errorLines = errors.map((error) => `error: ${error.path}: ${error.message}\n`);

  return {
    ok: true,
    value: {
      json: { tickets: tickets.map((ticket) => ticketView(ticket, false)), errors },
      text: [...lines, ...errorLines].join(''),
    },
  };
};
