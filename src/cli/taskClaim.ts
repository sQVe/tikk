import { deriveTaskState } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { forceOptions, invalidArguments, readForce, stringValue } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendAndShow,
  checkTree,
  readTarget,
  requireHolder,
  requireValue,
} from './taskCommand.ts';
import { conflict, withLockedTask } from './taskLock.ts';
import type { LockedTask } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';

const claimUsage =
  'Usage: tikk claim <id> --holder <h> [--lease <duration>] [--session <s>] [--session-log <path>] [--force --reason <text>] [--json]';

const releaseUsage = 'Usage: tikk release <id> --holder <h> [--json]';

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
