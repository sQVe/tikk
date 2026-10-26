import { deriveInstructionState } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { withoutNew } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { conflict, refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh, showOutput, storeFailure, instructionOutput } from './ticketView.ts';

const writeCanceled = async (
  input: CommandInput,
  ticket: CliTicket,
): Promise<Result<CliTicket, CliFailure>> => {
  const frontMatter = withoutNew({ ...ticket.frontMatter, status: 'canceled' as const });

  const written = await writeTicketWithStatus(input, {
    expectedHash: ticket.hash,
    ticket,
    frontMatter,
  });

  if (!written.ok) {
    return written;
  }

  return { ok: true, value: { ...ticket, hash: written.value.hash, frontMatter } };
};

const cancelInstruction = async (
  input: CommandInput,
  instruction: CliTicket,
): Promise<CommandResult> => {
  const now = input.effects.now();
  const facts = await input.session.listStateFacts([instruction.id]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const { state } = deriveInstructionState(instruction, facts.value, now);

  if (state === 'canceled') {
    return instructionOutput(instruction, state, null);
  }

  if (state === 'done') {
    return conflict(`Instruction ${instruction.id} is done, so it cannot be canceled.`);
  }

  const canceled = await writeCanceled(input, instruction);

  if (!canceled.ok) {
    return canceled;
  }

  return instructionOutput(canceled.value, 'canceled', null);
};

const cancelOther = async (input: CommandInput, ticket: CliTicket): Promise<CommandResult> => {
  const { status } = ticket.frontMatter;
  const now = input.effects.now();

  if (status === 'canceled') {
    return showOutput(input.session, now, ticket);
  }

  if (status === 'done') {
    return conflict(`Task ${ticket.id} is done, so it cannot be canceled.`);
  }

  const canceled = await writeCanceled(input, ticket);

  if (!canceled.ok) {
    return canceled;
  }

  return showAfterRefresh(input.session, now, ticket.id);
};

export const ticketCancel = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments('Usage: tikk cancel <id> [--json]');
  }

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    ticket.frontMatter.kind === 'instruction'
      ? cancelInstruction(input, ticket)
      : cancelOther(input, ticket),
  );
};
