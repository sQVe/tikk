import { validateFact } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { withLockedTicket } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

type AuditFact = Extract<Fact, { kind: 'audit' }>;

const usage = 'Usage: tikk audit <slice> --head <sha> --base <sha> --verdicts-file <path> [--json]';

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
    const detail = error instanceof Error ? error.message : String(error);

    return invalidArguments(`The verdicts file ${path} is not valid YAML: ${detail}`);
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

  const appended = await input.session.appendFact(machine, audit);

  if (!appended.ok) {
    const { kind, message } = appended.reason;

    return kind === 'invalid' ? invalidArguments(message) : storeFailure(message);
  }

  return showAfterRefresh(input.session, input.effects.now(), slice.id);
};

export const sliceAudit = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    head: { type: 'string' },
    base: { type: 'string' },
    'verdicts-file': { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const { values, positionals } = parsed.value;
  const [rawId, ...extra] = positionals;
  const head = stringValue(values, 'head');
  const base = stringValue(values, 'base');
  const path = stringValue(values, 'verdicts-file');

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  if (head === undefined || base === undefined || path === undefined) {
    return invalidArguments(usage);
  }

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
    head,
    base,
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
