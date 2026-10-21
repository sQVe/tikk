import type { ParseArgsOptionsConfig } from 'node:util';

import { deriveTaskState } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict } from './taskLock.ts';
import type { LockedTask } from './taskLock.ts';
import { checkSessionTree } from './ticketStatus.ts';
import { storeFailure, taskOutput } from './ticketView.ts';

interface Target {
  rawId: string;
  values: ParsedArguments['values'];
}

export const readTarget = (
  args: string[],
  options: ParseArgsOptionsConfig,
  usage: string,
): Result<Target, CliFailure> => {
  const parsed = parseCommandArguments(args, options);

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  return { ok: true, value: { rawId, values: parsed.value.values } };
};

export const requireValue = (
  values: ParsedArguments['values'],
  name: string,
  usage: string,
): Result<string, CliFailure> => {
  const value = stringValue(values, name);

  if (value === undefined || value === '') {
    return invalidArguments(`Give --${name}. ${usage}`);
  }

  return { ok: true, value };
};

export const appendAndShow = async (
  input: CommandInput,
  locked: LockedTask,
  fact: Fact,
): Promise<CommandResult> => {
  const appended = await input.session.appendFact(fact.machine, fact);

  if (!appended.ok) {
    const { kind, message } = appended.reason;

    return kind === 'invalid' ? invalidArguments(message) : storeFailure(message);
  }

  const { state, claim } = deriveTaskState(locked.task, [...locked.facts, fact], locked.now);

  return taskOutput(locked.task, state, claim);
};

export const requireHolder = (
  locked: LockedTask,
  holder: string,
): Result<undefined, CliFailure> => {
  const { state, claim } = deriveTaskState(locked.task, locked.facts, locked.now);

  if (claim === null) {
    return conflict(`Task ${locked.task.id} is ${state}, not active.`);
  }

  if (claim.holder !== holder) {
    return conflict(`Task ${locked.task.id} is held by ${claim.holder} until ${claim.leaseEnd}.`);
  }

  return { ok: true, value: undefined };
};

export const checkTree = (
  input: CommandInput,
  locked: LockedTask,
  forced: string | undefined,
): Result<undefined, CliFailure> => {
  if (forced !== undefined) {
    return { ok: true, value: undefined };
  }

  return checkSessionTree(input.session, locked.task.frontMatter);
};
