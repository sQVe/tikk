import { forceOptions, readForce, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendAndShow,
  appendAndShowItem,
  checkTree,
  readTarget,
  requireHolder,
  requireSubmission,
  requireValue,
} from './instructionCommand.ts';
import { withLockedInstruction } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';

const submitUsage =
  'Usage: tikk submit <id> --holder <h> [--text <t>] [--force --reason <text>] [--json]';

const acceptUsage = 'Usage: tikk accept <id> [--json]';

export const instructionSubmit = async (input: CommandInput): Promise<CommandResult> => {
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

  return withLockedInstruction(input, rawId, 'refuse', async (locked) => {
    const allowed = requireHolder(locked, holder.value);

    if (!allowed.ok) {
      return allowed;
    }

    const tree = checkTree(input, locked, forced.value);

    if (!tree.ok) {
      return tree;
    }

    return appendAndShowItem(input, locked, {
      version: 1,
      kind: 'log',
      ticket: locked.instruction.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      type: 'submitted',
      text: stringValue(values, 'text') ?? '',
      item: input.effects.newItemId(),
      holder: holder.value,
      ...(forced.value === undefined ? {} : { forced: forced.value }),
    });
  });
};

export const instructionAccept = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, {}, acceptUsage);

  if (!target.ok) {
    return target;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedInstruction(input, target.value.rawId, 'refuse', async (locked) => {
    const submission = requireSubmission(locked);

    if (!submission.ok) {
      return submission;
    }

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'accept',
      ticket: locked.instruction.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      item: submission.value.item,
    });
  });
};
