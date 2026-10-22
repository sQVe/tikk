import type { Result } from '../result.ts';
import { findCoverageGaps, groupTicketChildren } from '../ticket/ticket.ts';
import type { CoverageGap, TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type {
  CliFailure,
  CliSession,
  CliTicket,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { findTicket } from './ticketView.ts';

const gapLine = (gap: CoverageGap): string => {
  const missing = gap.kind === 'plan' ? 'no slice covers it' : 'no task covers it';

  return `${gap.ticket}  ${gap.criterion}  ${missing}\n`;
};

const scopeOf = (target: CliTicket, tickets: CliTicket[]): Set<TicketId> => {
  const scope = new Set<TicketId>([target.id]);

  if (target.frontMatter.kind === 'plan') {
    const slices = groupTicketChildren(tickets).get(target.id) ?? [];

    for (const slice of slices) {
      scope.add(slice.id);
    }
  }

  return scope;
};

const scopedGaps = (
  session: CliSession,
  rawId: string | undefined,
): Result<CoverageGap[], CliFailure> => {
  const tickets = session
    .listTickets({ includeArchived: false })
    .filter((ticket) => ticket.error === null);

  const gaps = findCoverageGaps(tickets);

  if (rawId === undefined) {
    return { ok: true, value: gaps };
  }

  const target = findTicket(session, rawId);

  if (!target.ok) {
    return target;
  }

  const { kind } = target.value.frontMatter;

  if (kind !== 'plan' && kind !== 'slice') {
    return invalidArguments(`Ticket ${rawId} is a ${kind}. Coverage is for a plan or a slice.`);
  }

  const scope = scopeOf(target.value, tickets);

  return { ok: true, value: gaps.filter((gap) => scope.has(gap.ticket)) };
};

export const coverageCommand = ({ args, session }: CommandInput): CommandResult => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (extra.length > 0) {
    return invalidArguments('Usage: tikk coverage [<id>] [--json]');
  }

  const found = scopedGaps(session, rawId);

  if (!found.ok) {
    return found;
  }

  return {
    ok: true,
    value: { json: { gaps: found.value }, text: found.value.map(gapLine).join('') },
  };
};
