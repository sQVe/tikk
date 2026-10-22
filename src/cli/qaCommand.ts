import { selectQaRuns, validateFact } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendEvidence,
  readEvidenceListing,
  readEvidenceTarget,
  targetOptions,
} from './evidenceTarget.ts';
import { readTarget, requireValue } from './taskCommand.ts';
import { refuseFileErrors, withLockedTicket } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';

type QaFact = Extract<Fact, { kind: 'qa' }>;

const addUsage =
  'Usage: tikk qa add <slice> --repository <r> --head <h> --base <b> --change-hash <c> --run-file <path> [--json]';

const listUsage = 'Usage: tikk qa ls <id> --head <h> [--change-hash <c>] [--json]';

const subcommandUsage = 'Usage: tikk qa <add|ls> <id> [arguments] [--json]';

const runIdLength = 12;

const runIdOf = (fact: Fact): string => {
  const withoutRun = Object.fromEntries(Object.entries(fact).filter(([key]) => key !== 'run'));
  const hasher = new Bun.CryptoHasher('sha256');

  hasher.update(JSON.stringify(withoutRun));

  return hasher.digest('hex').slice(0, runIdLength);
};

const readRunFile = async (
  input: CommandInput,
  path: string,
): Promise<{ ok: true; value: Record<string, unknown> } | ReturnType<typeof invalidArguments>> => {
  const text = await input.effects.readTextFile(path);

  if (text === undefined) {
    return invalidArguments(`Cannot read the run file ${path}.`);
  }

  let run: unknown;

  try {
    run = Bun.YAML.parse(text);
  } catch (error) {
    return invalidArguments(`The run file ${path} is not valid YAML: ${String(error)}`);
  }

  if (typeof run !== 'object' || run === null || Array.isArray(run)) {
    return invalidArguments(`The run file ${path} must hold a YAML map.`);
  }

  return { ok: true, value: Object.fromEntries(Object.entries(run)) };
};

const buildFact = (candidate: Record<string, unknown>): QaFact | string => {
  const draft = validateFact({ ...candidate, run: '000000000000' });

  if (!draft.ok) {
    return draft.reason.message;
  }

  const run = runIdOf(draft.value);
  const final = validateFact({ ...draft.value, run });

  invariant(final.ok, 'The qa fact should stay valid with its run ID.');
  invariant(final.value.kind === 'qa', 'The validated fact should be a qa fact.');

  return final.value;
};

const qaAdd = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    { 'run-file': { type: 'string' }, ...targetOptions },
    addUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const runFile = requireValue(values, 'run-file', addUsage);

  if (!runFile.ok) {
    return runFile;
  }

  const evidenceTarget = readEvidenceTarget(values, addUsage);

  if (!evidenceTarget.ok) {
    return evidenceTarget;
  }

  const run = await readRunFile(input, runFile.value);

  if (!run.ok) {
    return run;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTicket(input, rawId, refuseFileErrors, async (ticket) => {
    if (ticket.frontMatter.kind !== 'slice') {
      return invalidArguments(
        `Ticket ${ticket.id} is not a slice: its kind is ${ticket.frontMatter.kind}.`,
      );
    }

    const fact = buildFact({
      artifacts: [],
      gaps: [],
      ...run.value,
      version: 1,
      kind: 'qa',
      ticket: ticket.id,
      at: input.effects.now().toISOString(),
      machine: machine.value,
      target: evidenceTarget.value,
    });

    if (typeof fact === 'string') {
      return invalidArguments(fact);
    }

    const known = new Set((ticket.frontMatter.criteria ?? []).map((criterion) => criterion.id));
    const named = fact.scenarios.flatMap((scenario) => scenario.criteria);
    const unknown = named.find((criterion) => !known.has(criterion));

    if (unknown !== undefined) {
      return invalidArguments(`${unknown} is not a criterion of slice ${ticket.id}.`);
    }

    const appended = await appendEvidence(input, fact);

    if (!appended.ok) {
      return appended;
    }

    const qa = { ...fact, current: true };
    const count = fact.scenarios.length;

    return {
      ok: true,
      value: { json: { qa }, text: `${ticket.id}  ${fact.run}  ${count} scenarios\n` },
    };
  });
};

const qaList = async (input: CommandInput): Promise<CommandResult> => {
  const listing = await readEvidenceListing(input, listUsage);

  if (!listing.ok) {
    return listing;
  }

  const { ticketId, facts, state } = listing.value;
  const runs = selectQaRuns(facts, ticketId, state);

  const lines = runs.map((run) => {
    const mark = run.current ? 'current' : 'stale';

    return `${run.ticket}  ${run.run}  ${mark}  ${run.scenarios.length} scenarios\n`;
  });

  return { ok: true, value: { json: { runs }, text: lines.join('') } };
};

export const qaCommand = (input: CommandInput): Promise<CommandResult> => {
  const [subcommand, ...args] = input.args;
  const rest = { ...input, args };

  if (subcommand === 'add') {
    return qaAdd(rest);
  }

  if (subcommand === 'ls') {
    return qaList(rest);
  }

  return Promise.resolve(invalidArguments(subcommandUsage));
};
