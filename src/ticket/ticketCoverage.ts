import type { TicketId } from './ticketId.ts';
import type { TicketFrontMatter } from './ticketSchema.ts';
import { groupTicketChildren } from './ticketTree.ts';

interface CoverageTicket {
  id: TicketId;
  frontMatter: TicketFrontMatter;
}

export interface CoverageGap {
  ticket: TicketId;
  kind: 'plan' | 'slice';
  criterion: string;
}

const coveringKind = { plan: 'slice', slice: 'instruction' } as const;

const isActive = (ticket: CoverageTicket): boolean => ticket.frontMatter.status !== 'canceled';

const criterionIds = (ticket: CoverageTicket): string[] =>
  (ticket.frontMatter.criteria ?? []).map((criterion) => criterion.id);

const coveredBy = (child: CoverageTicket, parentCriteria: string[]): string[] => {
  const { covers } = child.frontMatter;

  if (covers === undefined) {
    return child.frontMatter.kind === 'instruction' ? parentCriteria : [];
  }

  return covers.filter((criterion) => parentCriteria.includes(criterion));
};

const gapsOf = (
  owner: CoverageTicket,
  kind: CoverageGap['kind'],
  children: CoverageTicket[],
): CoverageGap[] => {
  if (!isActive(owner)) {
    return [];
  }

  const criteria = criterionIds(owner);

  const covering = children.filter(
    (child) => isActive(child) && child.frontMatter.kind === coveringKind[kind],
  );

  const covered = new Set(covering.flatMap((child) => coveredBy(child, criteria)));

  return criteria
    .filter((criterion) => !covered.has(criterion))
    .map((criterion) => ({ ticket: owner.id, kind, criterion }));
};

// The IDs in covers that the parent has no criterion for, in the order given.
export const findUnknownCovers = (covers: string[], parent: CoverageTicket): string[] => {
  const parentCriteria = criterionIds(parent);

  return covers.filter((criterion) => !parentCriteria.includes(criterion));
};

// Gaps ordered by ticket ID, then by the criterion's order in front matter.
export const findCoverageGaps = (tickets: CoverageTicket[]): CoverageGap[] => {
  const children = groupTicketChildren(tickets);
  const gaps: CoverageGap[] = [];

  for (const ticket of tickets) {
    const { kind } = ticket.frontMatter;
    const ownChildren = children.get(ticket.id) ?? [];

    if (kind === 'plan' || kind === 'slice') {
      gaps.push(...gapsOf(ticket, kind, ownChildren));
    }
  }

  return gaps.toSorted((first, second) => first.ticket.localeCompare(second.ticket));
};
