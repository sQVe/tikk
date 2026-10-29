import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import { criterionFingerprint } from './criterionFingerprint.ts';
import type { Fact } from './factLine.ts';
import { deriveInstructionStateFromOwnFacts } from './instructionState.ts';

export type SliceStateName =
  | 'planned'
  | 'active'
  | 'inReview'
  | 'mergedUnverified'
  | 'flagged'
  | 'done';

export interface SliceTicket {
  id: TicketId;
  frontMatter: TicketFrontMatter;
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
  openInstructions: TicketId[];
  openTasks: TicketId[];
  pr: SlicePr | null;
}

export type SliceShownStateName = SliceStateName | 'draft' | 'canceled';

export interface ShownSliceState extends Omit<SliceState, 'state'> {
  state: SliceShownStateName;
}

export interface SliceIndex {
  factsByTicket: Map<TicketId, Fact[]>;
  instructionsBySlice: Map<TicketId, SliceTicket[]>;
  tasksByParent: Map<TicketId, SliceTicket[]>;
  slicesByPlan: Map<TicketId, SliceTicket[]>;
}

type PrFact = Extract<Fact, { kind: 'pr' }>;
type AuditFact = Extract<Fact, { kind: 'audit' }>;
type SliceCriterion = NonNullable<SliceTicket['frontMatter']['criteria']>[number];

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

const meetsCriterion = (criterion: SliceCriterion, audit: AuditFact): boolean => {
  const definition = criterionFingerprint(criterion);

  return audit.verdicts.some(
    (entry) => entry.criterion === criterion.id && entry.definition === definition,
  );
};

const meetsEveryCriterion = (slice: SliceTicket, audit: AuditFact): boolean => {
  const allVerdictsMet = audit.verdicts.every((entry) => entry.verdict === 'met');
  const criteria = slice.frontMatter.criteria ?? [];

  return allVerdictsMet && criteria.every((criterion) => meetsCriterion(criterion, audit));
};

const isStarted = (state: string): boolean =>
  state === 'active' || state === 'submitted' || state === 'done';

const isOpenInstruction = (state: string): boolean => state !== 'done' && state !== 'canceled';

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

  return { state, since, ageSeconds, openInstructions: [], openTasks: [], pr: null, ...extra };
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

const childrenByParent = (
  tickets: SliceTicket[],
  kind: SliceTicket['frontMatter']['kind'],
): Map<TicketId, SliceTicket[]> => {
  const children = tickets.filter(
    (ticket): ticket is SliceTicket & { frontMatter: { parent: TicketId } } =>
      ticket.frontMatter.kind === kind && ticket.frontMatter.parent !== undefined,
  );

  return Map.groupBy(children, (ticket) => ticket.frontMatter.parent);
};

export const buildSliceIndex = (tickets: SliceTicket[], facts: Fact[]): SliceIndex => ({
  factsByTicket: Map.groupBy(facts, (fact) => fact.ticket),
  instructionsBySlice: childrenByParent(tickets, 'instruction'),
  tasksByParent: childrenByParent(tickets, 'task'),
  slicesByPlan: childrenByParent(tickets, 'slice'),
});

export const selectSlicePr = (sliceId: TicketId, index: SliceIndex): SlicePr | null => {
  const pr = winningPrFact(index.factsByTicket.get(sliceId) ?? []);

  return pr === undefined ? null : prView(pr);
};

const openTasksOf = (sliceId: TicketId, index: SliceIndex): TicketId[] =>
  (index.tasksByParent.get(sliceId) ?? [])
    .filter((task) => task.frontMatter.status === 'open')
    .map((task) => task.id);

export const deriveSliceState = (slice: SliceTicket, index: SliceIndex, now: Date): SliceState => {
  const { factsByTicket } = index;
  const own = factsByTicket.get(slice.id) ?? [];
  const pr = winningPrFact(own);

  const instructions = (index.instructionsBySlice.get(slice.id) ?? []).map((ticket) => {
    const instructionFacts = factsByTicket.get(ticket.id) ?? [];

    return {
      id: ticket.id,
      facts: instructionFacts,
      state: deriveInstructionStateFromOwnFacts(ticket, instructionFacts, now).state,
    };
  });

  if (pr === undefined || pr.state === 'closed') {
    const started = instructions.filter((instruction) => isStarted(instruction.state));

    if (started.length === 0) {
      return pending('planned', [], now);
    }

    const deciding = started.flatMap(
      (instruction) => instruction.facts.findLast(isStateFact)?.at ?? [],
    );

    return pending('active', deciding, now);
  }

  const view = prView(pr);

  if (pr.state === 'open' || !pr.inTrunk) {
    return pending('inReview', [pr.at], now, { pr: view });
  }

  const openInstructions = instructions
    .filter((instruction) => isOpenInstruction(instruction.state))
    .map((instruction) => instruction.id);

  const openTasks = openTasksOf(slice.id, index);
  const open = { openInstructions, openTasks, pr: view };
  const audit = decidingAudit(own, pr);

  if (audit === undefined || !meetsEveryCriterion(slice, audit)) {
    return pending('mergedUnverified', [pr.at], now, open);
  }

  const hasOpenWork = openInstructions.length > 0 || openTasks.length > 0;
  const state = hasOpenWork ? 'flagged' : 'done';

  return pending(state, [pr.at, audit.at], now, open);
};

// A slice that is not open shows its stored status.
export const deriveShownSliceState = (
  slice: SliceTicket,
  index: SliceIndex,
  now: Date,
): ShownSliceState => {
  const derived = deriveSliceState(slice, index, now);
  const { status } = slice.frontMatter;

  if (status === 'open') {
    return derived;
  }

  return { ...derived, state: status };
};
