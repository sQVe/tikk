import { parseReviewFindings, redactSecrets, selectFindings } from '../fact/fact.ts';
import type { Fact, ReviewFinding } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { appendEvidence, readEvidenceTarget, targetOptions } from './evidenceTarget.ts';
import { readTarget, requireValue } from './instructionCommand.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, storeFailure } from './ticketView.ts';

const addUsage =
  'Usage: tikk review add <id> --repository <r> --head <h> --base <b> --change-hash <c> --capture-hash <c> --mode <m> --findings-file <path> [--json]';

const listUsage = 'Usage: tikk review ls <id> [--json]';

const subcommandUsage = 'Usage: tikk review <add|ls> <id> [arguments] [--json]';

const readFindings = async (
  input: CommandInput,
  path: string,
): Promise<Result<ReviewFinding[], CliFailure>> => {
  const text = await input.effects.readTextFile(path);

  if (text === undefined) {
    return invalidArguments(`Cannot read the findings file ${path}.`);
  }

  const parsed = parseReviewFindings(text);

  if (!parsed.ok) {
    return invalidArguments(`The findings file ${path} is invalid: ${parsed.reason.message}`);
  }

  return parsed;
};

const reviewAdd = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    {
      'capture-hash': { type: 'string' },
      mode: { type: 'string' },
      'findings-file': { type: 'string' },
      ...targetOptions,
    },
    addUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const evidenceTarget = readEvidenceTarget(values, addUsage);

  if (!evidenceTarget.ok) {
    return evidenceTarget;
  }

  const captureHash = requireValue(values, 'capture-hash', addUsage);

  if (!captureHash.ok) {
    return captureHash;
  }

  const mode = requireValue(values, 'mode', addUsage);

  if (!mode.ok) {
    return mode;
  }

  const findingsFile = requireValue(values, 'findings-file', addUsage);

  if (!findingsFile.ok) {
    return findingsFile;
  }

  const findings = await readFindings(input, findingsFile.value);

  if (!findings.ok) {
    return findings;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTicket(input, rawId, refuseFileErrors, async (ticket) => {
    const facts = await input.session.listFacts([ticket.id]);

    if (!facts.ok) {
      return storeFailure(facts.reason.message);
    }

    const fact: Fact = {
      version: 1,
      kind: 'review',
      ticket: ticket.id,
      at: input.effects.now().toISOString(),
      machine: machine.value,
      target: evidenceTarget.value,
      captureHash: captureHash.value,
      mode: mode.value,
      findings: findings.value.map((finding) =>
        Object.assign({}, finding, { claim: redactSecrets(finding.claim) }),
      ),
    };

    const appended = await appendEvidence(input, fact);

    if (!appended.ok) {
      return appended;
    }

    const entries = selectFindings([...facts.value, fact], ticket.id);

    const lines = entries.map(
      (entry) => `${entry.fingerprint}  ${entry.status}  ${entry.match}  ${entry.claim}\n`,
    );

    return {
      ok: true,
      value: { json: { review: fact, findings: entries }, text: lines.join('') },
    };
  });
};

const reviewList = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, {}, listUsage);

  if (!target.ok) {
    return target;
  }

  const ticket = findTicket(input.session, target.value.rawId);

  if (!ticket.ok) {
    return ticket;
  }

  const facts = await input.session.listFacts([ticket.value.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const reviews = facts.value
    .filter((fact) => fact.kind === 'review')
    .toReversed()
    .map((review) => ({
      at: review.at,
      target: review.target,
      captureHash: review.captureHash,
      mode: review.mode,
      findingCount: review.findings.length,
    }));

  const lines = reviews.map(
    (review) =>
      `${ticket.value.id}  ${review.at}  ${review.mode}  ${review.findingCount} findings\n`,
  );

  return { ok: true, value: { json: { reviews }, text: lines.join('') } };
};

export const reviewCommand = (input: CommandInput): Promise<CommandResult> => {
  const [subcommand, ...args] = input.args;
  const rest = { ...input, args };

  if (subcommand === 'add') {
    return reviewAdd(rest);
  }

  if (subcommand === 'ls') {
    return reviewList(rest);
  }

  return Promise.resolve(invalidArguments(subcommandUsage));
};
