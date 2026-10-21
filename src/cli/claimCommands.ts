import type { ParseArgsOptionsConfig } from 'node:util';

import { deriveTaskState } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import {
  forceOptions,
  invalidArguments,
  parseCommandArguments,
  readForce,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict, withLockedTask } from './taskLock.ts';
import type { LockedTask } from './taskLock.ts';
import { checkSessionTree } from './ticketStatus.ts';
import { storeFailure, taskOutput } from './ticketView.ts';

interface Target {
  rawId: string;
  values: ParsedArguments['values'];
}

type LogType = 'progress' | 'question' | 'answer' | 'discovered';

const claimUsage =
  'Usage: tikk claim <id> --holder <h> [--lease <duration>] [--session <s>] [--session-log <path>] [--force --reason <text>] [--json]';

const releaseUsage = 'Usage: tikk release <id> --holder <h> [--json]';

const logUsage =
  'Usage: tikk log <id> --type <progress|question|answer|discovered> --text <t> [--holder <h>] [--json]';

const submitUsage =
  'Usage: tikk submit <id> --holder <h> [--text <t>] [--force --reason <text>] [--json]';

const acceptUsage = 'Usage: tikk accept <id> [--json]';
const leasePattern = /^([1-9][0-9]*)([smh])$/;
const maximumLeaseDays = 30;
const hoursPerDay = 24;

const secondMilliseconds = 1000;
const minuteMilliseconds = 60_000;
const hourMilliseconds = 3_600_000;

const unitMilliseconds = new Map([
  ['s', secondMilliseconds],
  ['m', minuteMilliseconds],
  ['h', hourMilliseconds],
]);

const logTypes = new Set<string>(['progress', 'question', 'answer', 'discovered']);

const isLogType = (value: string): value is LogType => logTypes.has(value);

const readTarget = (
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

const requireValue = (
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

const parseLease = (text: string): Result<number, CliFailure> => {
  const match = leasePattern.exec(text);
  const unit = unitMilliseconds.get(match?.[2] ?? '');

  if (match === null || unit === undefined) {
    return invalidArguments(`Lease "${text}" must be <n>s, <n>m, or <n>h.`);
  }

  const milliseconds = Number(match[1]) * unit;

  if (milliseconds > maximumLeaseDays * hoursPerDay * hourMilliseconds) {
    return invalidArguments(`Lease "${text}" is longer than ${maximumLeaseDays} days.`);
  }

  return { ok: true, value: milliseconds };
};

const resolveMachine = async (input: CommandInput): Promise<Result<string, CliFailure>> => {
  const machine = await input.effects.resolveMachine();

  if (!machine.ok) {
    return invalidArguments(machine.reason.message);
  }

  return machine;
};

const appendAndShow = async (
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

const requireHolder = (locked: LockedTask, holder: string): Result<undefined, CliFailure> => {
  const { state, claim } = deriveTaskState(locked.task, locked.facts, locked.now);

  if (claim === null) {
    return conflict(`Task ${locked.task.id} is ${state}, not active.`);
  }

  if (claim.holder !== holder) {
    return conflict(`Task ${locked.task.id} is held by ${claim.holder} until ${claim.leaseEnd}.`);
  }

  return { ok: true, value: undefined };
};

const checkTree = (
  input: CommandInput,
  locked: LockedTask,
  forced: string | undefined,
): Result<undefined, CliFailure> => {
  if (forced !== undefined) {
    return { ok: true, value: undefined };
  }

  return checkSessionTree(input.session, locked.task.frontMatter);
};

const requireClaimable = (locked: LockedTask, holder: string): Result<undefined, CliFailure> => {
  const { state } = deriveTaskState(locked.task, locked.facts, locked.now);

  if (state === 'active') {
    return requireHolder(locked, holder);
  }

  if (state !== 'open') {
    return conflict(`Task ${locked.task.id} is ${state}, so it cannot be claimed.`);
  }

  return { ok: true, value: undefined };
};

export const taskClaim = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    {
      holder: { type: 'string' },
      lease: { type: 'string' },
      session: { type: 'string' },
      'session-log': { type: 'string' },
      ...forceOptions,
    },
    claimUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const holder = requireValue(values, 'holder', claimUsage);

  if (!holder.ok) {
    return holder;
  }

  const lease = parseLease(stringValue(values, 'lease') ?? '1h');

  if (!lease.ok) {
    return lease;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const forced = readForce(values);

  if (!forced.ok) {
    return forced;
  }

  const session = stringValue(values, 'session');
  const sessionLog = stringValue(values, 'session-log');

  return withLockedTask(input, rawId, 'refuse', async (locked) => {
    const allowed = requireClaimable(locked, holder.value);

    if (!allowed.ok) {
      return allowed;
    }

    const tree = checkTree(input, locked, forced.value);

    if (!tree.ok) {
      return tree;
    }

    const leaseEnd = new Date(locked.now.getTime() + lease.value).toISOString();

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'claim',
      ticket: locked.task.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      holder: holder.value,
      leaseEnd,
      ...(forced.value === undefined ? {} : { forced: forced.value }),
      ...(session === undefined ? {} : { session }),
      ...(sessionLog === undefined ? {} : { sessionLog }),
    });
  });
};

export const taskRelease = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, { holder: { type: 'string' } }, releaseUsage);

  if (!target.ok) {
    return target;
  }

  const holder = requireValue(target.value.values, 'holder', releaseUsage);

  if (!holder.ok) {
    return holder;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTask(input, target.value.rawId, 'refuse', async (locked) => {
    const allowed = requireHolder(locked, holder.value);

    if (!allowed.ok) {
      return allowed;
    }

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'release',
      ticket: locked.task.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      holder: holder.value,
    });
  });
};

export const taskLog = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    { type: { type: 'string' }, text: { type: 'string' }, holder: { type: 'string' } },
    logUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const type = requireValue(values, 'type', logUsage);

  if (!type.ok) {
    return type;
  }

  if (!isLogType(type.value)) {
    return invalidArguments(`Log type "${type.value}" is not valid. ${logUsage}`);
  }

  const logType = type.value;
  const text = requireValue(values, 'text', logUsage);

  if (!text.ok) {
    return text;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const holder = stringValue(values, 'holder');

  return withLockedTask(input, rawId, 'allow', (locked) =>
    appendAndShow(input, locked, {
      version: 1,
      kind: 'log',
      ticket: locked.task.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      type: logType,
      text: text.value,
      ...(holder === undefined ? {} : { holder }),
    }),
  );
};

export const taskSubmit = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    { holder: { type: 'string' }, text: { type: 'string' }, ...forceOptions },
    submitUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const holder = requireValue(values, 'holder', submitUsage);

  if (!holder.ok) {
    return holder;
  }

  const forced = readForce(values);

  if (!forced.ok) {
    return forced;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTask(input, rawId, 'refuse', async (locked) => {
    const allowed = requireHolder(locked, holder.value);

    if (!allowed.ok) {
      return allowed;
    }

    const tree = checkTree(input, locked, forced.value);

    if (!tree.ok) {
      return tree;
    }

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'log',
      ticket: locked.task.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      type: 'submitted',
      text: stringValue(values, 'text') ?? '',
      holder: holder.value,
      ...(forced.value === undefined ? {} : { forced: forced.value }),
    });
  });
};

export const taskAccept = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, {}, acceptUsage);

  if (!target.ok) {
    return target;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTask(input, target.value.rawId, 'refuse', async (locked) => {
    const { state } = deriveTaskState(locked.task, locked.facts, locked.now);

    if (state !== 'submitted') {
      return conflict(`Task ${locked.task.id} is ${state}, not submitted.`);
    }

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'accept',
      ticket: locked.task.id,
      at: locked.now.toISOString(),
      machine: machine.value,
    });
  });
};
