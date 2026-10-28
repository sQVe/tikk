import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { storeFailure, ticketView } from './ticketView.ts';

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

  if (!listed.ok) {
    return storeFailure(listed.reason.message);
  }

  const tickets = listed.value.filter(
    (ticket) => project === undefined || ticket.frontMatter.project === project,
  );

  const errors = session.listErrors();

  if (!errors.ok) {
    return storeFailure(errors.reason.message);
  }

  const lines = tickets.map((ticket) => {
    const { kind, status, title } = ticket.frontMatter;

    return `${ticket.id}  ${kind}  ${status}  ${title}\n`;
  });

  const errorLines = errors.value.map((error) => `error: ${error.path}: ${error.message}\n`);

  return {
    ok: true,
    value: {
      json: { tickets: tickets.map((ticket) => ticketView(ticket, false)), errors: errors.value },
      text: [...lines, ...errorLines].join(''),
    },
  };
};
