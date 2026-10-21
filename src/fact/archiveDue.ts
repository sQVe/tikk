import { collectTicketTree, groupTicketChildren } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';

export interface ArchiveTicket {
  id: TicketId;
  frontMatter: Pick<TicketFrontMatter, 'kind' | 'status' | 'parent' | 'archived'>;
}

type FinalStatus = 'canceled' | 'closed';

export interface ArchiveDue {
  date: string;
  archive: TicketId[];
  // Finished roots with no fact that dates the finish. Their 14 days start at the new fact.
  statusFacts: { ticket: TicketId; status: FinalStatus }[];
}

type Finish = { kind: 'dated'; at: number } | { kind: 'undated'; status: FinalStatus };

const dayMilliseconds = 86_400_000;
const archiveDelayDays = 14;
const archiveDelayMilliseconds = archiveDelayDays * dayMilliseconds;
const isoDateLength = 'YYYY-MM-DD'.length;

const isRoot = (ticket: ArchiveTicket): boolean =>
  ticket.frontMatter.kind === 'plan' || ticket.frontMatter.parent === undefined;

const factsByTicket = (facts: Fact[]): Map<TicketId, Fact[]> => {
  const grouped = new Map<TicketId, Fact[]>();

  for (const fact of facts) {
    const own = grouped.get(fact.ticket) ?? [];

    own.push(fact);
    grouped.set(fact.ticket, own);
  }

  return grouped;
};

const newestTime = (own: Fact[], matches: (fact: Fact) => boolean): number | undefined => {
  const times = own.filter(matches).map((fact) => Date.parse(fact.at));

  return times.length === 0 ? undefined : Math.max(...times);
};

const finishOf = (root: ArchiveTicket, own: Fact[]): Finish | undefined => {
  const { kind, status } = root.frontMatter;

  if (status === 'canceled' || status === 'closed') {
    const at = newestTime(own, (fact) => fact.kind === 'status' && fact.status === status);

    return at === undefined ? { kind: 'undated', status } : { kind: 'dated', at };
  }

  if (kind !== 'task' || status !== 'open') {
    return undefined;
  }

  const accepted = newestTime(own, (fact) => fact.kind === 'accept');

  return accepted === undefined ? undefined : { kind: 'dated', at: accepted };
};

// The date in UTC, as the archived field holds it.
export const archiveDateOf = (now: Date): string => now.toISOString().slice(0, isoDateLength);

const archivableIn = (
  root: ArchiveTicket,
  finishedAt: number,
  children: Map<TicketId, ArchiveTicket[]>,
  grouped: Map<TicketId, Fact[]>,
): TicketId[] => {
  const archivable: TicketId[] = [];

  for (const ticket of collectTicketTree(root, children)) {
    const own = grouped.get(ticket.id) ?? [];
    const unarchived = newestTime(own, (fact) => fact.kind === 'unarchive') ?? -Infinity;

    if (ticket.frontMatter.archived === undefined && unarchived <= finishedAt) {
      archivable.push(ticket.id);
    }
  }

  return archivable;
};

// A root is a plan or a ticket with no parent. A finished root is due 14 days after its finish,
// and then it and its descendants are archived. A ticket unarchived after that finish stays out.
export const findArchiveDue = (tickets: ArchiveTicket[], facts: Fact[], now: Date): ArchiveDue => {
  const children = groupTicketChildren(tickets);
  const grouped = factsByTicket(facts);
  const due: ArchiveDue = { date: archiveDateOf(now), archive: [], statusFacts: [] };

  for (const root of tickets.filter(isRoot)) {
    const finish = finishOf(root, grouped.get(root.id) ?? []);

    if (finish?.kind === 'undated') {
      due.statusFacts.push({ ticket: root.id, status: finish.status });
    }

    if (finish?.kind !== 'dated' || now.getTime() - finish.at < archiveDelayMilliseconds) {
      continue;
    }

    due.archive.push(...archivableIn(root, finish.at, children, grouped));
  }

  return due;
};
