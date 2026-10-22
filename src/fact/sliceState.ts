import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import type { Fact } from './factLine.ts';
import { deriveTaskStateFromOwnFacts } from './taskState.ts';

export type SliceStateName = 'planned' | 'active' | 'inReview' | 'mergedUnverified' | 'done';

interface SliceTicket {
  id: TicketId;
  frontMatter: Pick<TicketFrontMatter, 'kind' | 'status' | 'parent' | 'criteria'>;
}

interface SlicePr {
  repository: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  base: string;
  head: string;
  mergeCommit: string | null;
  inTrunk: boolean;
  checkedAt: string;
}

export interface SliceState {
  state: SliceStateName;
  since: string | null;
  ageSeconds: number | null;
  flagged: boolean;
  openTasks: TicketId[];
  pr: SlicePr | null;
}

export interface SliceIndex {
  factsByTicket: Map<TicketId, Fact[]>;
  tasksBySlice: Map<TicketId, SliceTicket[]>;
}

type PrFact = Extract<Fact, { kind: 'pr' }>;
type AuditFact = Extract<Fact, { kind: 'audit' }>;

const millisecondsPerSecond = 1000;

const winningPrFact = (own: Fact[]): PrFact | undefined => {
  const prFacts = own.filter((fact) => fact.kind === 'pr');
  const newest = prFacts.at(-1);

  if (newest === undefined) {
    return undefined;
  }

  const samePr = prFacts.filter(
    (fact) => fact.repository === newest.repository && fact.number === newest.number,
  );

  // A slow reconcile can append an observation older than the one before it. A merge stays merged,
  // and a merge seen in trunk stays in trunk, whatever order the facts arrive in.
  const inTrunk = samePr.findLast((fact) => fact.state === 'merged' && fact.inTrunk);
  const merged = samePr.findLast((fact) => fact.mergeCommit !== undefined);

  return inTrunk ?? merged ?? newest;
};

const isAuditFact = (fact: Fact): fact is AuditFact => fact.kind === 'audit';

const decidingAudit = (own: Fact[], pr: PrFact): AuditFact | undefined =>
  own
    .filter(isAuditFact)
    .findLast((fact) => fact.head === pr.head && fact.repository === pr.repository);

const meetsEveryCriterion = (slice: SliceTicket, audit: AuditFact): boolean => {
  const met = new Set(
    audit.verdicts.filter((entry) => entry.verdict === 'met').map((entry) => entry.criterion),
  );

  const allVerdictsMet = audit.verdicts.every((entry) => entry.verdict === 'met');
  const criteria = slice.frontMatter.criteria ?? [];

  return allVerdictsMet && criteria.every((criterion) => met.has(criterion.id));
};

const isStarted = (state: string): boolean =>
  state === 'active' || state === 'submitted' || state === 'done';

const isOpenTask = (state: string): boolean => state !== 'done' && state !== 'canceled';

const isSubmittedLog = (fact: Fact): boolean => fact.kind === 'log' && fact.type === 'submitted';

const isStateFact = (fact: Fact): boolean =>
  fact.kind === 'claim' || fact.kind === 'accept' || isSubmittedLog(fact);

const oldestAt = (times: string[]): string | null =>
  times.toSorted((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

const pending = (
  state: SliceStateName,
  deciding: string[],
  now: Date,
  extra: Partial<SliceState> = {},
): SliceState => {
  const since = oldestAt(deciding);

  const ageSeconds =
    since === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / millisecondsPerSecond));

  return { state, since, ageSeconds, flagged: false, openTasks: [], pr: null, ...extra };
};

const prView = (fact: PrFact): SlicePr => ({
  repository: fact.repository,
  number: fact.number,
  state: fact.state,
  base: fact.base,
  head: fact.head,
  mergeCommit: fact.mergeCommit ?? null,
  inTrunk: fact.inTrunk,
  checkedAt: fact.at,
});

export const buildSliceIndex = (tickets: SliceTicket[], facts: Fact[]): SliceIndex => {
  const tasks = tickets.filter(
    (ticket): ticket is SliceTicket & { frontMatter: { parent: TicketId } } =>
      ticket.frontMatter.kind === 'task' && ticket.frontMatter.parent !== undefined,
  );

  return {
    factsByTicket: Map.groupBy(facts, (fact) => fact.ticket),
    tasksBySlice: Map.groupBy(tasks, (ticket) => ticket.frontMatter.parent),
  };
};

export const selectSlicePr = (sliceId: TicketId, index: SliceIndex): SlicePr | null => {
  const pr = winningPrFact(index.factsByTicket.get(sliceId) ?? []);

  return pr === undefined ? null : prView(pr);
};

export const deriveSliceState = (slice: SliceTicket, index: SliceIndex, now: Date): SliceState => {
  const { factsByTicket } = index;
  const own = factsByTicket.get(slice.id) ?? [];
  const pr = winningPrFact(own);

  const tasks = (index.tasksBySlice.get(slice.id) ?? []).map((ticket) => {
    const taskFacts = factsByTicket.get(ticket.id) ?? [];

    return {
      id: ticket.id,
      facts: taskFacts,
      state: deriveTaskStateFromOwnFacts(ticket, taskFacts, now).state,
    };
  });

  if (pr === undefined || pr.state === 'closed') {
    const started = tasks.filter((task) => isStarted(task.state));

    if (started.length === 0) {
      return pending('planned', [], now);
    }

    const deciding = started.flatMap((task) => task.facts.findLast(isStateFact)?.at ?? []);

    return pending('active', deciding, now);
  }

  const view = prView(pr);

  if (pr.state === 'open' || !pr.inTrunk) {
    return pending('inReview', [pr.at], now, { pr: view });
  }

  const openTasks = tasks.filter((task) => isOpenTask(task.state)).map((task) => task.id);
  const flags = { flagged: openTasks.length > 0, openTasks, pr: view };
  const audit = decidingAudit(own, pr);

  if (audit !== undefined && meetsEveryCriterion(slice, audit)) {
    return pending('done', [pr.at, audit.at], now, flags);
  }

  return pending('mergedUnverified', [pr.at], now, flags);
};
