import { deriveSliceState } from '../fact/fact.ts';
import type { Fact, SliceState } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { parseCommandArguments, invalidArguments } from './cliArguments.ts';
import type {
  CliEffects,
  CliFailure,
  CliSession,
  CliTicket,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { differsFromObservation, makePrFact, readPullRequest } from './prGithub.ts';
import type { PullRequestObservation, PullRequestRef } from './prGithub.ts';

export interface ReconcileProblem {
  ticket: TicketId | null;
  repository: string | null;
  number: number | null;
  message: string;
}

interface UpdatedSlice {
  id: TicketId;
  state: PullRequestObservation['state'];
}

export interface ReconcileOutcome {
  checked: TicketId[];
  updated: UpdatedSlice[];
  problems: ReconcileProblem[];
}

interface ReconcileInput {
  effects: CliEffects;
  session: CliSession;
}

interface Target {
  slice: CliTicket;
  pr: NonNullable<SliceState['pr']>;
}

interface Change extends PullRequestRef {
  ticket: TicketId;
  seen: PullRequestObservation;
}

const reconcileUsage = 'Usage: tikk reconcile [--json]';

const globalProblem = (message: string): ReconcileProblem => ({
  ticket: null,
  repository: null,
  number: null,
  message,
});

export const problemLines = (problems: ReconcileProblem[]): string =>
  problems.map((problem) => `problem: ${problem.message}\n`).join('');

const isOpenSlice = (ticket: CliTicket): boolean =>
  ticket.error === null &&
  ticket.frontMatter.kind === 'slice' &&
  ticket.frontMatter.status === 'open';

const appendChanges = async (
  { effects, session }: ReconcileInput,
  changes: Change[],
  outcome: ReconcileOutcome,
): Promise<void> => {
  const machine = await effects.resolveMachine();

  if (!machine.ok) {
    outcome.problems.push(globalProblem(machine.reason.message));

    return;
  }

  const lock = await session.lockStore();

  if (!lock.ok) {
    outcome.problems.push(globalProblem(lock.reason.message));

    return;
  }

  try {
    for (const change of changes) {
      const fact = makePrFact(
        { ticket: change.ticket, at: effects.now(), machine: machine.value },
        change,
        change.seen,
      );

      // oxlint-disable-next-line eslint/no-await-in-loop -- Appends to one fact file run one at a time.
      const appended = await session.appendFact(machine.value, fact);

      if (appended.ok) {
        outcome.updated.push({ id: change.ticket, state: change.seen.state });
      } else {
        outcome.problems.push({
          ticket: change.ticket,
          repository: change.repository,
          number: change.number,
          message: appended.reason.message,
        });
      }
    }
  } finally {
    await lock.value.release();
  }
};

const isSettled = (pr: { state: string; inTrunk: boolean }): boolean =>
  pr.state === 'merged' && pr.inTrunk;

const readTarget = async (
  effects: CliEffects,
  target: Target,
): Promise<Change | ReconcileProblem | undefined> => {
  const { slice, pr } = target;
  const ref = { repository: pr.repository, number: pr.number };
  const seen = await readPullRequest(effects.runGh, ref);

  if (!seen.ok) {
    const label = `${ref.repository}#${ref.number} of ${slice.id}`;
    const message = `Cannot read pull request ${label}: ${seen.reason.message}`;

    return { ticket: slice.id, ...ref, message };
  }

  return differsFromObservation(pr, seen.value)
    ? { ticket: slice.id, ...ref, seen: seen.value }
    : undefined;
};

const isChange = (result: Change | ReconcileProblem | undefined): result is Change =>
  result !== undefined && 'seen' in result;

const isProblem = (result: Change | ReconcileProblem | undefined): result is ReconcileProblem =>
  result !== undefined && 'message' in result;

const collectChanges = async (
  { effects, session }: ReconcileInput,
  slices: CliTicket[],
  facts: Fact[],
  outcome: ReconcileOutcome,
): Promise<Change[]> => {
  const outlines = session.listTicketOutlines();

  const targets = slices.flatMap((slice): Target[] => {
    const { pr } = deriveSliceState(slice, outlines, facts, effects.now());

    return pr === null || isSettled(pr) ? [] : [{ slice, pr }];
  });

  outcome.checked.push(...targets.map((target) => target.slice.id));

  const results = await Promise.all(targets.map((target) => readTarget(effects, target)));

  outcome.problems.push(...results.filter(isProblem));

  return results.filter(isChange);
};

// All gh calls run before the store lock, which is taken only to append.
export const reconcilePullRequests = async (input: ReconcileInput): Promise<ReconcileOutcome> => {
  const outcome: ReconcileOutcome = { checked: [], updated: [], problems: [] };
  const slices = input.session.listTickets({ includeArchived: false }).filter(isOpenSlice);
  const facts = await input.session.listStateFacts();

  if (!facts.ok) {
    outcome.problems.push(globalProblem(facts.reason.message));

    return outcome;
  }

  const changes = await collectChanges(input, slices, facts.value, outcome);

  if (changes.length > 0) {
    await appendChanges(input, changes, outcome);
  }

  if (outcome.updated.length > 0) {
    await input.effects.scheduleSync();
  }

  return outcome;
};

export const reconcileBeforeRead = async (
  input: ReconcileInput,
): Promise<Result<ReconcileProblem[], CliFailure>> => {
  const outcome = await reconcilePullRequests(input);

  if (outcome.updated.length === 0) {
    return { ok: true, value: outcome.problems };
  }

  const refreshed = await input.session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
  }

  return { ok: true, value: outcome.problems };
};

export const reconcileCommand = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments(reconcileUsage);
  }

  const outcome = await reconcilePullRequests(input);
  const updatedLines = outcome.updated.map((slice) => `${slice.id}  ${slice.state}\n`).join('');

  return {
    ok: true,
    value: {
      json: {
        checked: outcome.checked,
        updated: outcome.updated.map((slice) => slice.id),
        problems: outcome.problems,
      },
      text: `${updatedLines}${problemLines(outcome.problems)}`,
    },
  };
};
