import { validateFact } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { withLockedTicket } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

type AuditFact = Extract<Fact, { kind: 'audit' }>;

interface AuditArguments {
  rawId: string;
  repository: string;
  head: string;
  base: string;
  changeHash: string;
  path: string;
}

type QaFact = Extract<Fact, { kind: 'qa' }>;

const usage =
  'Usage: tikk audit <slice> --repository <owner/name> --head <sha> --base <sha> --change-hash <hash> --verdicts-file <path> [--json]';

const ownerNamePattern = /^[^/\s]+\/[^/\s]+$/;

const readVerdictsFile = async (
  input: CommandInput,
  path: string,
): Promise<{ ok: true; value: unknown[] } | ReturnType<typeof invalidArguments>> => {
  const text = await input.effects.readTextFile(path);

  if (text === undefined) {
    return invalidArguments(`Cannot read the verdicts file ${path}.`);
  }

  let verdicts: unknown;

  try {
    verdicts = Bun.YAML.parse(text);
  } catch (error) {
    return invalidArguments(`The verdicts file ${path} is not valid YAML: ${String(error)}`);
  }

  if (!Array.isArray(verdicts)) {
    return invalidArguments(`The verdicts file ${path} must hold a YAML list.`);
  }

  return { ok: true, value: verdicts };
};

const checkCriteria = (slice: CliTicket, audit: AuditFact): string | undefined => {
  const known = (slice.frontMatter.criteria ?? []).map((criterion) => criterion.id);
  const seen = new Set<string>();

  for (const { criterion } of audit.verdicts) {
    if (!known.includes(criterion)) {
      return `${criterion} is not a criterion of slice ${slice.id}.`;
    }

    if (seen.has(criterion)) {
      return `Criterion ${criterion} has a verdict twice.`;
    }

    seen.add(criterion);
  }

  const missing = known.filter((criterion) => !seen.has(criterion));

  if (missing.length > 0) {
    return `Criteria with no verdict: ${missing.join(', ')}.`;
  }

  return undefined;
};

const checkCitation = (
  slice: CliTicket,
  audit: AuditFact,
  verdict: AuditFact['verdicts'][number],
  run: QaFact | undefined,
  runId: string,
): string | undefined => {
  if (run === undefined) {
    return `QA run ${runId} is not a QA run of slice ${slice.id}.`;
  }

  if (run.target.repository !== audit.repository || run.target.head !== audit.head) {
    return `QA run ${runId} is for another repository or head than this audit.`;
  }

  const scenarios = run.scenarios.filter((scenario) =>
    scenario.criteria.includes(verdict.criterion),
  );

  if (scenarios.length === 0) {
    return `QA run ${runId} has no scenario for criterion ${verdict.criterion}.`;
  }

  const unmet = scenarios.some((scenario) => scenario.verdict !== 'pass');

  if (verdict.verdict === 'met' && unmet) {
    return `QA run ${runId} has a scenario for ${verdict.criterion} that did not pass, so the verdict cannot be met.`;
  }

  return undefined;
};

const checkCitations = (slice: CliTicket, audit: AuditFact, facts: Fact[]): string | undefined => {
  const runs = facts.filter(
    (fact): fact is QaFact => fact.kind === 'qa' && fact.ticket === slice.id,
  );

  for (const verdict of audit.verdicts) {
    for (const runId of verdict.qa ?? []) {
      const run = runs.find((candidate) => candidate.run === runId);
      const problem = checkCitation(slice, audit, verdict, run, runId);

      if (problem !== undefined) {
        return problem;
      }
    }
  }

  return undefined;
};

const appendAudit = async (
  input: CommandInput,
  slice: CliTicket,
  audit: AuditFact,
  machine: string,
): Promise<CommandResult> => {
  const problem = checkCriteria(slice, audit);

  if (problem !== undefined) {
    return invalidArguments(problem);
  }

  const facts = await input.session.listFacts([slice.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const citation = checkCitations(slice, audit, facts.value);

  if (citation !== undefined) {
    return invalidArguments(citation);
  }

  const appended = await input.session.appendFact(machine, audit);

  if (!appended.ok) {
    const { kind, message } = appended.reason;

    return kind === 'invalid' ? invalidArguments(message) : storeFailure(message);
  }

  return showAfterRefresh(input.session, input.effects.now(), slice.id);
};

const parseAuditArguments = (
  args: string[],
): { ok: true; value: AuditArguments } | ReturnType<typeof invalidArguments> => {
  const parsed = parseCommandArguments(args, {
    repository: { type: 'string' },
    head: { type: 'string' },
    base: { type: 'string' },
    'change-hash': { type: 'string' },
    'verdicts-file': { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const { values, positionals } = parsed.value;
  const [rawId, ...extra] = positionals;
  const repository = stringValue(values, 'repository');
  const head = stringValue(values, 'head');
  const base = stringValue(values, 'base');
  const changeHash = stringValue(values, 'change-hash');
  const path = stringValue(values, 'verdicts-file');

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  if (repository === undefined || head === undefined || base === undefined) {
    return invalidArguments(usage);
  }

  if (changeHash === undefined || path === undefined) {
    return invalidArguments(usage);
  }

  if (!ownerNamePattern.test(repository)) {
    return invalidArguments(`"${repository}" is not a repository. Use owner/name.`);
  }

  return { ok: true, value: { rawId, repository, head, base, changeHash, path } };
};

export const sliceAudit = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseAuditArguments(input.args);

  if (!parsed.ok) {
    return parsed;
  }

  const { rawId, repository, head, base, changeHash, path } = parsed.value;

  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  if (found.value.frontMatter.kind !== 'slice') {
    return invalidArguments(
      `Ticket ${found.value.id} is not a slice: its kind is ${found.value.frontMatter.kind}.`,
    );
  }

  const verdicts = await readVerdictsFile(input, path);

  if (!verdicts.ok) {
    return verdicts;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const candidate = {
    version: 1,
    kind: 'audit',
    ticket: found.value.id,
    at: input.effects.now().toISOString(),
    machine: machine.value,
    repository,
    head,
    base,
    changeHash,
    verdicts: verdicts.value,
  };

  const audit = validateFact(candidate);

  if (!audit.ok) {
    return invalidArguments(audit.reason.message);
  }

  const fact = audit.value;

  invariant(fact.kind === 'audit', 'The validated fact should be an audit.');

  return withLockedTicket(input, rawId, { fileErrors: 'refuse', requireTask: false }, (locked) =>
    appendAudit(input, locked, fact, machine.value),
  );
};
