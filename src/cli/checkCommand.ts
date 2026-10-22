import { redactSecrets, selectChecks } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, stringValue } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { appendEvidence, readEvidenceTarget, targetOptions } from './evidenceTarget.ts';
import { readTarget, requireValue } from './taskCommand.ts';
import { refuseFileErrors, withLockedTicket } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, storeFailure } from './ticketView.ts';

const addUsage =
  'Usage: tikk check add <id> --command <c> --exit-code <n> --repository <r> --head <h> --base <b> --change-hash <c> [--log-file <path>] [--json]';

const listUsage = 'Usage: tikk check ls <id> --head <h> [--json]';

const subcommandUsage = 'Usage: tikk check <add|ls> <id> [arguments] [--json]';

const readExitCode = (text: string): Result<number, CliFailure> => {
  if (!/^\d+$/.test(text)) {
    return invalidArguments(`--exit-code must be an integer of 0 or more. ${addUsage}`);
  }

  return { ok: true, value: Number(text) };
};

const readLogHash = async (
  input: CommandInput,
  logFile: string | undefined,
): Promise<Result<string | undefined, CliFailure>> => {
  if (logFile === undefined) {
    return { ok: true, value: undefined };
  }

  const text = await input.effects.readTextFile(logFile);

  if (text === undefined) {
    return invalidArguments(`Cannot read the log file ${logFile}.`);
  }

  const stored = await input.session.storeLog(text);

  if (!stored.ok) {
    return { ok: false, reason: { code: 'storeError', message: stored.reason.message } };
  }

  return { ok: true, value: stored.value.hash };
};

const checkAdd = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    {
      command: { type: 'string' },
      'exit-code': { type: 'string' },
      'log-file': { type: 'string' },
      ...targetOptions,
    },
    addUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const command = requireValue(values, 'command', addUsage);

  if (!command.ok) {
    return command;
  }

  const exitCodeText = requireValue(values, 'exit-code', addUsage);

  if (!exitCodeText.ok) {
    return exitCodeText;
  }

  const exitCode = readExitCode(exitCodeText.value);

  if (!exitCode.ok) {
    return exitCode;
  }

  const evidenceTarget = readEvidenceTarget(values, addUsage);

  if (!evidenceTarget.ok) {
    return evidenceTarget;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const logFile = stringValue(values, 'log-file');

  return withLockedTicket(input, rawId, refuseFileErrors, async (ticket) => {
    const log = await readLogHash(input, logFile);

    if (!log.ok) {
      return log;
    }

    const fact: Fact = {
      version: 1,
      kind: 'check',
      ticket: ticket.id,
      at: input.effects.now().toISOString(),
      machine: machine.value,
      target: evidenceTarget.value,
      command: redactSecrets(command.value),
      exitCode: exitCode.value,
      ...(log.value === undefined ? {} : { log: log.value }),
    };

    const appended = await appendEvidence(input, fact);

    if (!appended.ok) {
      return appended;
    }

    const check = { ...fact, current: true };

    return {
      ok: true,
      value: { json: { check }, text: `${ticket.id}  ${fact.exitCode}  ${fact.command}\n` },
    };
  });
};

const checkList = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, { head: { type: 'string' } }, listUsage);

  if (!target.ok) {
    return target;
  }

  const head = requireValue(target.value.values, 'head', listUsage);

  if (!head.ok) {
    return head;
  }

  const ticket = findTicket(input.session, target.value.rawId);

  if (!ticket.ok) {
    return ticket;
  }

  const facts = await input.session.listFacts([ticket.value.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const checks = selectChecks(facts.value, ticket.value.id, head.value);

  const lines = checks.map((check) => {
    const mark = check.current ? 'current' : 'stale';

    return `${check.ticket}  ${check.exitCode}  ${mark}  ${check.command}\n`;
  });

  return { ok: true, value: { json: { checks }, text: lines.join('') } };
};

export const checkCommand = (input: CommandInput): Promise<CommandResult> => {
  const [subcommand, ...args] = input.args;
  const rest = { ...input, args };

  if (subcommand === 'add') {
    return checkAdd(rest);
  }

  if (subcommand === 'ls') {
    return checkList(rest);
  }

  return Promise.resolve(invalidArguments(subcommandUsage));
};
