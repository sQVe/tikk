import { buildSliceIndex, selectSlicePr } from '../fact/fact.ts';
import type { Fact, SliceIndex, SliceState } from '../fact/fact.ts';
import { ghSignal, readPullRequest } from '../github.ts';
import type { PullRequestObservation, PullRequestRef } from '../github.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { parseCommandArguments, invalidArguments } from './cliArguments.ts';
import type {
  CliEffects,
  CliFailure,
  CliSession,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { differsFromObservation, makePrFact } from './prGithub.ts';

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
  slice: TicketId;
  pr: NonNullable<SliceState['pr']>;
}

interface Change extends PullRequestRef {
  ticket: TicketId;
  seen: PullRequestObservation;
}

type TicketOutline = ReturnType<CliSession['listTicketOutlines']>[number];

const reconcileUsage = 'Usage: tikk reconcile [--json]';

const globalProblem = (message: string): ReconcileProblem => ({
  ticket: null,
  repository: null,
  number: null,
  message,
});

export const problemLines = (problems: ReconcileProblem[]): string =>
  problems.map((problem) => `problem: ${problem.message}\n`).join('');

const isOpenSlice = ({ frontMatter }: TicketOutline): boolean =>
  frontMatter.kind === 'slice' &&
  frontMatter.status === 'open' &&
  frontMatter.archived === undefined;

const changeProblem = (change: Change, message: string): ReconcileProblem => ({
  ticket: change.ticket,
  repository: change.repository,
  number: change.number,
  message,
});

const isStillSelected = (change: Change, index: SliceIndex): boolean => {
  const selected = selectSlicePr(change.ticket, index);

  return selected?.repository === change.repository && selected.number === change.number;
};

// Another process may link a different PR while gh runs, so the selection is read again under the
// lock before anything is appended.
// Picking a slice's PR reads only the slice's own facts, so the index holds no tasks.
const readCurrentIndex = async (
  session: CliSession,
  sliceIds: TicketId[],
): Promise<Result<SliceIndex, { message: string }>> => {
  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return refreshed;
  }

  const facts = await session.listStateFacts(sliceIds);

  if (!facts.ok) {
    return facts;
  }

  return { ok: true, value: buildSliceIndex([], facts.value) };
};

const appendSelected = async (
  { effects, session }: ReconcileInput,
  changes: Change[],
  machine: string,
  outcome: ReconcileOutcome,
): Promise<void> => {
  const index = await readCurrentIndex(
    session,
    changes.map((change) => change.ticket),
  );

  if (!index.ok) {
    outcome.problems.push(globalProblem(index.reason.message));

    return;
  }

  const selected = changes.filter((change) => isStillSelected(change, index.value));

  for (const change of selected) {
    const fact = makePrFact(
      { ticket: change.ticket, at: effects.now(), machine },
      change,
      change.seen,
    );

    // oxlint-disable-next-line eslint/no-await-in-loop -- Appends to one fact file run one at a time.
    const appended = await session.appendFact(machine, fact);

    if (appended.ok) {
      outcome.updated.push({ id: change.ticket, state: change.seen.state });
    } else {
      outcome.problems.push(changeProblem(change, appended.reason.message));
    }
  }
};

const appendChanges = async (
  input: ReconcileInput,
  changes: Change[],
  outcome: ReconcileOutcome,
): Promise<void> => {
  const { effects, session } = input;
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
    await appendSelected(input, changes, machine.value, outcome);
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
  const seen = await readPullRequest(effects.runGh, ref, ghSignal());

  if (!seen.ok) {
    const label = `${ref.repository}#${ref.number} of ${slice}`;
    const message = `Cannot read pull request ${label}: ${seen.reason.message}`;

    return { ticket: slice, ...ref, message };
  }

  return differsFromObservation(pr, seen.value)
    ? { ticket: slice, ...ref, seen: seen.value }
    : undefined;
};

const isChange = (result: Change | ReconcileProblem | undefined): result is Change =>
  result !== undefined && 'seen' in result;

const isProblem = (result: Change | ReconcileProblem | undefined): result is ReconcileProblem =>
  result !== undefined && 'message' in result;

const collectChanges = async (
  { effects }: ReconcileInput,
  slices: TicketId[],
  facts: Fact[],
  outcome: ReconcileOutcome,
): Promise<Change[]> => {
  const index = buildSliceIndex([], facts);

  const targets = slices.flatMap((slice): Target[] => {
    const pr = selectSlicePr(slice, index);

    return pr === null || isSettled(pr) ? [] : [{ slice, pr }];
  });

  outcome.checked.push(...targets.map((target) => target.slice));

  const results = await Promise.all(targets.map((target) => readTarget(effects, target)));

  outcome.problems.push(...results.filter(isProblem));

  return results.filter(isChange);
};

// All gh calls run before the store lock, which is taken only to append.
export const reconcilePullRequests = async (input: ReconcileInput): Promise<ReconcileOutcome> => {
  const outcome: ReconcileOutcome = { checked: [], updated: [], problems: [] };

  const slices = input.session
    .listTicketOutlines()
    .filter(isOpenSlice)
    .map((outline) => outline.id);

  if (slices.length === 0) {
    return outcome;
  }

  const facts = await input.session.listStateFacts(slices);

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
