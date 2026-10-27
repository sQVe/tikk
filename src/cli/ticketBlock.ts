import type { Result } from '../result.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { checkSessionTree, checkWaitCycle, writeTicketAndShow } from './ticketStatus.ts';
import { showOutput } from './ticketView.ts';

interface EdgeArguments {
  rawId: string;
  blocker: TicketId;
}

const parseEdgeArguments = (
  input: CommandInput,
  command: 'block' | 'unblock',
): Result<EdgeArguments, CliFailure> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, rawBlocker, ...extra] = parsed.value.positionals;

  if (rawId === undefined || rawBlocker === undefined || extra.length > 0) {
    return invalidArguments(`Usage: tikk ${command} <id> <blocker> [--json]`);
  }

  const blocker = parseTicketId(rawBlocker);

  if (!blocker.ok) {
    return invalidArguments(
      `The blocker ${rawBlocker} is not a ticket ID. ${blocker.reason.message}`,
    );
  }

  return { ok: true, value: { rawId, blocker: blocker.value } };
};

const addBlocker = async (
  input: CommandInput,
  ticket: CliTicket,
  blocker: TicketId,
): Promise<CommandResult> => {
  if (ticket.frontMatter.blockedBy.includes(blocker)) {
    return showOutput(input.session, input.effects.now(), ticket);
  }

  const frontMatter = {
    ...ticket.frontMatter,
    blockedBy: [...ticket.frontMatter.blockedBy, blocker],
  };

  const checked = checkSessionTree(input.session, frontMatter);

  if (!checked.ok) {
    return checked;
  }

  const acyclic = checkWaitCycle(input.session, ticket.id, blocker);

  if (!acyclic.ok) {
    return acyclic;
  }

  return writeTicketAndShow(input, { expectedHash: ticket.hash, ticket, frontMatter });
};

const removeBlocker = async (
  input: CommandInput,
  ticket: CliTicket,
  blocker: TicketId,
): Promise<CommandResult> => {
  const { blockedBy } = ticket.frontMatter;

  if (!blockedBy.includes(blocker)) {
    return showOutput(input.session, input.effects.now(), ticket);
  }

  const remaining = blockedBy.filter((target) => target !== blocker);

  return writeTicketAndShow(input, {
    expectedHash: ticket.hash,
    ticket,
    frontMatter: { ...ticket.frontMatter, blockedBy: remaining },
  });
};

export const ticketBlock = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseEdgeArguments(input, 'block');

  if (!parsed.ok) {
    return parsed;
  }

  const { rawId, blocker } = parsed.value;

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    addBlocker(input, ticket, blocker),
  );
};

export const ticketUnblock = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseEdgeArguments(input, 'unblock');

  if (!parsed.ok) {
    return parsed;
  }

  const { rawId, blocker } = parsed.value;

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    removeBlocker(input, ticket, blocker),
  );
};
