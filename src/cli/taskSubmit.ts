import { deriveTaskState } from '../fact/fact.ts';
import { forceOptions, readForce, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendAndShow,
  checkTree,
  readTarget,
  requireHolder,
  requireValue,
} from './taskCommand.ts';
import { conflict, withLockedTask } from './taskLock.ts';
import { resolveMachine } from './ticketStatus.ts';

const submitUsage =
  'Usage: tikk submit <id> --holder <h> [--text <t>] [--force --reason <text>] [--json]';

const acceptUsage = 'Usage: tikk accept <id> [--json]';

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
