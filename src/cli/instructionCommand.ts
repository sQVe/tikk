import type { ParseArgsOptionsConfig } from 'node:util';

import { deriveInstructionState, latestSubmission } from '../fact/fact.ts';
import type { Fact, InstructionItem } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict } from './instructionLock.ts';
import type { LockedInstruction } from './instructionLock.ts';
import { checkSessionTree } from './ticketStatus.ts';
import { instructionItemOutput, instructionOutput } from './ticketView.ts';

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

const appendInstructionFact = async (
  input: CommandInput,
  fact: Fact,
): Promise<Result<undefined, CliFailure>> => {
  const appended = await input.session.appendFact(fact.machine, fact);

  if (!appended.ok) {
    const { kind, message } = appended.reason;
    const code = kind === 'invalid' ? 'invalidArguments' : 'storeError';

    return { ok: false, reason: { code, message } };
  }

  return { ok: true, value: undefined };
};

export const appendAndShow = async (
  input: CommandInput,
  locked: LockedInstruction,
  fact: Fact,
): Promise<CommandResult> => {
  const appended = await appendInstructionFact(input, fact);

  if (!appended.ok) {
    return appended;
  }

  const derived = deriveInstructionState(locked.instruction, [...locked.facts, fact], locked.now);

  return instructionOutput(locked.instruction, derived);
};

// Shows the item that a question or a submission created, so later commands can name it.
export const appendAndShowItem = async (
  input: CommandInput,
  locked: LockedInstruction,
  fact: Fact & { item: string },
): Promise<CommandResult> => {
  const appended = await appendInstructionFact(input, fact);

  if (!appended.ok) {
    return appended;
  }

  const derived = deriveInstructionState(locked.instruction, [...locked.facts, fact], locked.now);

  return instructionItemOutput(locked.instruction, derived, fact.item);
};

export const requireHolder = (
  locked: LockedInstruction,
  holder: string,
): Result<undefined, CliFailure> => {
  const { state, claim } = deriveInstructionState(locked.instruction, locked.facts, locked.now);

  if (claim === null) {
    return conflict(`Instruction ${locked.instruction.id} is ${state}, not active.`);
  }

  if (claim.holder !== holder) {
    return conflict(
      `Instruction ${locked.instruction.id} is held by ${claim.holder} until ${claim.leaseEnd}.`,
    );
  }

  return { ok: true, value: undefined };
};

export const checkTree = (
  input: CommandInput,
  locked: LockedInstruction,
  forced: string | undefined,
): Result<undefined, CliFailure> => {
  if (forced !== undefined) {
    return { ok: true, value: undefined };
  }

  return checkSessionTree(input.session, locked.instruction.frontMatter);
};

// The locked facts hold only what decides the state, so questions and pass-ups are read here.
export const listInstructionFacts = async (
  input: CommandInput,
  locked: LockedInstruction,
): Promise<Result<Fact[], CliFailure>> => {
  const facts = await input.session.listFacts([locked.instruction.id]);

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  return facts;
};

// The submission that an accept, a reject, or a pass-up decides on.
export const requireSubmission = (
  locked: LockedInstruction,
): Result<InstructionItem, CliFailure> => {
  const { state } = deriveInstructionState(locked.instruction, locked.facts, locked.now);
  const submission = latestSubmission(locked.facts);

  if (state !== 'submitted' || submission === undefined) {
    return conflict(`Instruction ${locked.instruction.id} is ${state}, not submitted.`);
  }

  return { ok: true, value: submission };
};
