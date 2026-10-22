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

const isActive = (ticket: CoverageTicket): boolean => ticket.frontMatter.status !== 'canceled';

const criterionIds = (ticket: CoverageTicket): string[] =>
  (ticket.frontMatter.criteria ?? []).map((criterion) => criterion.id);

const coveredBy = (child: CoverageTicket, parentCriteria: string[]): string[] => {
  const { covers } = child.frontMatter;

  if (covers === undefined) {
    return child.frontMatter.kind === 'task' ? parentCriteria : [];
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
  const covered = new Set(children.filter(isActive).flatMap((child) => coveredBy(child, criteria)));

  return criteria
    .filter((criterion) => !covered.has(criterion))
    .map((criterion) => ({ ticket: owner.id, kind, criterion }));
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
