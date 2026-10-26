import { redactSecrets, selectFindings } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import { invariant } from '../invariant.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { appendEvidence } from './evidenceTarget.ts';
import { readTarget, requireValue } from './instructionCommand.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, storeFailure } from './ticketView.ts';

type FindingStatus = Extract<Fact, { kind: 'finding' }>['status'];

const statuses = new Set<string>(['open', 'fixed', 'notWorthChanging', 'incorrect', 'blocked']);

const isFindingStatus = (value: string): value is FindingStatus => statuses.has(value);

const setUsage =
  'Usage: tikk finding set <id> <fingerprint> --status <open|fixed|notWorthChanging|incorrect|blocked> --reason <r> --actor <a> [--json]';

const listUsage =
  'Usage: tikk finding ls <id> [--status <open|fixed|notWorthChanging|incorrect|blocked>] [--json]';

const subcommandUsage = 'Usage: tikk finding <set|ls> <id> [arguments] [--json]';

const findingSet = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    status: { type: 'string' },
    reason: { type: 'string' },
    actor: { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, fingerprint, ...extra] = parsed.value.positionals;

  if (rawId === undefined || fingerprint === undefined || extra.length > 0) {
    return invalidArguments(setUsage);
  }

  const { values } = parsed.value;
  const status = requireValue(values, 'status', setUsage);

  if (!status.ok) {
    return status;
  }

  if (!isFindingStatus(status.value)) {
    return invalidArguments(`Finding status "${status.value}" is not valid. ${setUsage}`);
  }

  const findingStatus = status.value;
  const reason = requireValue(values, 'reason', setUsage);

  if (!reason.ok) {
    return reason;
  }

  const actor = requireValue(values, 'actor', setUsage);

  if (!actor.ok) {
    return actor;
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

    const known = selectFindings(facts.value, ticket.id).some(
      (entry) => entry.fingerprint === fingerprint,
    );

    if (!known) {
      const message = `Ticket ${ticket.id} has no finding ${fingerprint}.`;

      return { ok: false, reason: { code: 'notFound', message } };
    }

    const fact: Fact = {
      version: 1,
      kind: 'finding',
      ticket: ticket.id,
      at: input.effects.now().toISOString(),
      machine: machine.value,
      fingerprint,
      status: findingStatus,
      actor: actor.value,
      reason: redactSecrets(reason.value),
    };

    const appended = await appendEvidence(input, fact);

    if (!appended.ok) {
      return appended;
    }

    const entries = selectFindings([...facts.value, fact], ticket.id);
    const finding = entries.find((entry) => entry.fingerprint === fingerprint);

    invariant(finding !== undefined, 'The finding was just written.');

    return {
      ok: true,
      value: { json: { finding }, text: `${fingerprint}  ${findingStatus}  ${finding.claim}\n` },
    };
  });
};

const findingList = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, { status: { type: 'string' } }, listUsage);

  if (!target.ok) {
    return target;
  }

  const status = stringValue(target.value.values, 'status');

  if (status !== undefined && !isFindingStatus(status)) {
    return invalidArguments(`Finding status "${status}" is not valid. ${listUsage}`);
  }

  const ticket = findTicket(input.session, target.value.rawId);

  if (!ticket.ok) {
    return ticket;
  }

  const facts = await input.session.listFacts([ticket.value.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const findings = selectFindings(facts.value, ticket.value.id).filter(
    (entry) => status === undefined || entry.status === status,
  );

  const lines = findings.map((entry) => `${entry.fingerprint}  ${entry.status}  ${entry.claim}\n`);

  return { ok: true, value: { json: { findings }, text: lines.join('') } };
};

export const findingCommand = (input: CommandInput): Promise<CommandResult> => {
  const [subcommand, ...args] = input.args;
  const rest = { ...input, args };

  if (subcommand === 'set') {
    return findingSet(rest);
  }

  if (subcommand === 'ls') {
    return findingList(rest);
  }

  return Promise.resolve(invalidArguments(subcommandUsage));
};
