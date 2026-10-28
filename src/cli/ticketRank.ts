import { compareRank } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { parseTicketId, withoutNew } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { fileErrorFailure, refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh } from './ticketView.ts';

type Placement =
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'before'; sibling: TicketId }
  | { kind: 'after'; sibling: TicketId };

interface RankArguments {
  rawId: string;
  placement: Placement;
}

interface RankedTicket {
  ticket: CliTicket;
  rank: number;
}

const usage =
  'Usage: tikk rank <id> --first | --last | --before <sibling> | --after <sibling> [--json]';

const placementFlags = ['first', 'last', 'before', 'after'];

const parseSibling = (
  kind: 'before' | 'after',
  rawSibling: string,
): Result<Placement, CliFailure> => {
  const sibling = parseTicketId(rawSibling);

  if (!sibling.ok) {
    return invalidArguments(
      `The sibling ${rawSibling} is not a ticket ID. ${sibling.reason.message}`,
    );
  }

  return { ok: true, value: { kind, sibling: sibling.value } };
};

const parsePlacement = (values: ParsedArguments['values']): Result<Placement, CliFailure> => {
  const givenCount = placementFlags.filter((flag) => values[flag] !== undefined).length;

  if (givenCount !== 1) {
    return invalidArguments(`Give exactly one of --first, --last, --before, or --after. ${usage}`);
  }

  if (values['first'] === true) {
    return { ok: true, value: { kind: 'first' } };
  }

  if (values['last'] === true) {
    return { ok: true, value: { kind: 'last' } };
  }

  const before = stringValue(values, 'before');

  if (before !== undefined) {
    return parseSibling('before', before);
  }

  const after = stringValue(values, 'after');

  if (after !== undefined) {
    return parseSibling('after', after);
  }

  return invalidArguments(usage);
};

const parseRankArguments = (input: CommandInput): Result<RankArguments, CliFailure> => {
  const parsed = parseCommandArguments(input.args, {
    first: { type: 'boolean' },
    last: { type: 'boolean' },
    before: { type: 'string' },
    after: { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  const placement = parsePlacement(parsed.value.values);

  if (!placement.ok) {
    return placement;
  }

  return { ok: true, value: { rawId, placement: placement.value } };
};

// The tree and `tikk ready` order each kind apart, so a rank only means something within one kind.
const isSibling = (candidate: CliTicket, ticket: CliTicket): boolean =>
  candidate.frontMatter.project === ticket.frontMatter.project &&
  candidate.frontMatter.parent === ticket.frontMatter.parent &&
  candidate.frontMatter.kind === ticket.frontMatter.kind;

const siblingsOf = (input: CommandInput, ticket: CliTicket): Result<CliTicket[], CliFailure> => {
  const listed = input.session.listTickets({ includeArchived: false });

  if (!listed.ok) {
    return { ok: false, reason: { code: 'storeError', message: listed.reason.message } };
  }

  return { ok: true, value: listed.value.filter((candidate) => isSibling(candidate, ticket)) };
};

const orderSiblings = (
  siblings: CliTicket[],
  ticket: CliTicket,
  placement: Placement,
): Result<CliTicket[], CliFailure> => {
  const others = siblings.filter((sibling) => sibling.id !== ticket.id).toSorted(compareRank);

  if (placement.kind === 'first') {
    return { ok: true, value: [ticket, ...others] };
  }

  if (placement.kind === 'last') {
    return { ok: true, value: [...others, ticket] };
  }

  if (placement.sibling === ticket.id) {
    return invalidArguments(`Ticket ${ticket.id} cannot be ranked next to itself.`);
  }

  const target = others.findIndex((sibling) => sibling.id === placement.sibling);

  if (target === -1) {
    return invalidArguments(
      `${placement.sibling} is not a sibling of ${ticket.id}. It must exist, share its project and parent, and not be archived.`,
    );
  }

  const index = placement.kind === 'before' ? target : target + 1;

  return { ok: true, value: [...others.slice(0, index), ticket, ...others.slice(index)] };
};

const planRanks = (ordered: CliTicket[], ticket: CliTicket): Result<RankedTicket[], CliFailure> => {
  const planned = ordered.map((entry, index) => ({ ticket: entry, rank: index + 1 }));

  const changed = planned.filter(
    (entry) => entry.ticket.id === ticket.id || entry.ticket.frontMatter.rank !== entry.rank,
  );

  const broken = changed.find(
    (entry) => entry.ticket.id !== ticket.id && entry.ticket.error !== null,
  );

  if (broken !== undefined) {
    return fileErrorFailure(broken.ticket);
  }

  return { ok: true, value: changed };
};

const rankedFrontMatter = (ranked: RankedTicket, ticket: CliTicket): TicketFrontMatter => {
  const frontMatter = { ...ranked.ticket.frontMatter, rank: ranked.rank };

  return ranked.ticket.id === ticket.id ? withoutNew(frontMatter) : frontMatter;
};

const writeRanks = async (
  input: CommandInput,
  ticket: CliTicket,
  ranks: RankedTicket[],
): Promise<CommandResult> => {
  const writtenPaths: string[] = [];

  for (const ranked of ranks) {
    // Writes run one at a time, so a failure names exactly the files written before it.
    // oxlint-disable-next-line eslint/no-await-in-loop -- See above.
    const written = await writeTicketWithStatus(input, {
      expectedHash: ranked.ticket.hash,
      ticket: ranked.ticket,
      frontMatter: rankedFrontMatter(ranked, ticket),
    });

    if (!written.ok) {
      const writtenList = writtenPaths.join(', ') || 'none';

      const message = `${written.reason.message} Files already written: ${writtenList}.`;

      return { ok: false, reason: { code: written.reason.code, message } };
    }

    writtenPaths.push(ranked.ticket.path);
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
};

const rankTicket = async (
  input: CommandInput,
  ticket: CliTicket,
  placement: Placement,
): Promise<CommandResult> => {
  if (ticket.frontMatter.archived !== undefined) {
    return invalidArguments(`Ticket ${ticket.id} is archived, so it cannot be ranked.`);
  }

  const siblings = siblingsOf(input, ticket);

  if (!siblings.ok) {
    return siblings;
  }

  const ordered = orderSiblings(siblings.value, ticket, placement);

  if (!ordered.ok) {
    return ordered;
  }

  const ranks = planRanks(ordered.value, ticket);

  if (!ranks.ok) {
    return ranks;
  }

  return writeRanks(input, ticket, ranks.value);
};

export const ticketRank = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseRankArguments(input);

  if (!parsed.ok) {
    return parsed;
  }

  const { rawId, placement } = parsed.value;

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    rankTicket(input, ticket, placement),
  );
};
