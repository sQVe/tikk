import { selectOpenQuestions, selectPassedUp } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendAndShow,
  listInstructionFacts,
  readTarget,
  requireSubmission,
  requireValue,
} from './instructionCommand.ts';
import { conflict, withLockedInstruction } from './instructionLock.ts';
import type { LockedInstruction } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';

const rejectUsage = 'Usage: tikk reject <id> --reason <text> [--json]';

const passUpUsage = 'Usage: tikk pass-up <id> --item <item> [--json]';

export const instructionReject = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, { reason: { type: 'string' } }, rejectUsage);

  if (!target.ok) {
    return target;
  }

  const reason = requireValue(target.value.values, 'reason', rejectUsage);

  if (!reason.ok) {
    return reason;
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
      kind: 'reject',
      ticket: locked.instruction.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      item: submission.value.item,
      reason: reason.value,
    });
  });
};

const isWaitingItem = (locked: LockedInstruction, own: Fact[], item: string): boolean => {
  const isOpenQuestion = selectOpenQuestions(own).some((question) => question.item === item);
  const submission = requireSubmission(locked);
  const isCurrentSubmission = submission.ok && submission.value.item === item;

  return isOpenQuestion || isCurrentSubmission;
};

const checkPassUp = (
  locked: LockedInstruction,
  own: Fact[],
  item: string,
): Result<undefined, CliFailure> => {
  const { id } = locked.instruction;

  if (!isWaitingItem(locked, own, item)) {
    return conflict(`Item ${item} is not an open question or the current submission of ${id}.`);
  }

  if (selectPassedUp(own).has(item)) {
    return conflict(`Item ${item} on ${id} is already passed up.`);
  }

  return { ok: true, value: undefined };
};

export const instructionPassUp = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(input.args, { item: { type: 'string' } }, passUpUsage);

  if (!target.ok) {
    return target;
  }

  const item = requireValue(target.value.values, 'item', passUpUsage);

  if (!item.ok) {
    return item;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedInstruction(input, target.value.rawId, 'allow', async (locked) => {
    const own = await listInstructionFacts(input, locked);

    if (!own.ok) {
      return own;
    }

    const allowed = checkPassUp(locked, own.value, item.value);

    if (!allowed.ok) {
      return allowed;
    }

    return appendAndShow(input, locked, {
      version: 1,
      kind: 'passUp',
      ticket: locked.instruction.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      item: item.value,
    });
  });
};
