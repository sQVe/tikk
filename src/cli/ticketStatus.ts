import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import {
  checkTicketTree,
  findUnknownCovers,
  findWaitCycle,
  serializeTicketFile,
} from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId, TicketLookup } from '../ticket/ticket.ts';
import { invalidArguments } from './cliArguments.ts';
import type {
  CliFailure,
  CliSession,
  CliTicket,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { unsharedIdFailure } from './factAppendFailure.ts';
import { showAfterRefresh } from './ticketView.ts';

interface StatusWrite {
  ticket: CliTicket;
  expectedHash: string;
  frontMatter: TicketFrontMatter;
  // Replaces the body of the loaded ticket when present.
  body?: string;
  // The reason given with --force, recorded on the status fact.
  forced?: string | undefined;
}

export const resolveMachine = async (input: CommandInput): Promise<Result<string, CliFailure>> => {
  const machine = await input.effects.resolveMachine();

  if (!machine.ok) {
    return invalidArguments(machine.reason.message);
  }

  return machine;
};

export const checkSessionTree = (
  session: CliSession,
  frontMatter: TicketFrontMatter,
): Result<undefined, CliFailure> => {
  let lookupFailure: string | undefined;

  const lookup: TicketLookup = (id) => {
    const found = session.getTicket(id);

    if (!found.ok) {
      if (found.reason.kind === 'failed') {
        lookupFailure = found.reason.message;
      }

      return undefined;
    }

    return { kind: found.value.frontMatter.kind, hasFileError: found.value.error !== null };
  };

  const checked = checkTicketTree(frontMatter, lookup);

  if (lookupFailure !== undefined) {
    return { ok: false, reason: { code: 'storeError', message: lookupFailure } };
  }

  if (!checked.ok) {
    return invalidArguments(checked.reason.message);
  }

  return checked;
};

export const checkWaitCycle = (
  session: CliSession,
  id: TicketId,
  target: TicketId,
): Result<undefined, CliFailure> => {
  const listed = session.listTickets({ includeArchived: true });

  if (!listed.ok) {
    return { ok: false, reason: { code: 'storeError', message: listed.reason.message } };
  }

  const cycle = findWaitCycle(listed.value, id, target);

  if (cycle !== undefined) {
    return invalidArguments(
      `Ticket ${id} cannot wait on ${target}, because it would wait on itself: ${cycle.join(', ')}.`,
    );
  }

  return { ok: true, value: undefined };
};

export const checkCovers = (
  session: CliSession,
  id: TicketId,
  covers: string[],
  parent: TicketId | undefined,
): Result<undefined, CliFailure> => {
  if (covers.length === 0) {
    return { ok: true, value: undefined };
  }

  if (parent === undefined) {
    return invalidArguments(
      `Ticket ${id} covers ${covers.join(', ')}, but it has no parent, so it has no criteria to cover.`,
    );
  }

  const found = session.getTicket(parent);

  if (!found.ok && found.reason.kind === 'failed') {
    return { ok: false, reason: { code: 'storeError', message: found.reason.message } };
  }

  if (!found.ok) {
    return invalidArguments(found.reason.message);
  }

  const unknown = findUnknownCovers(covers, found.value);

  if (unknown.length > 0) {
    return invalidArguments(`Covers names no criterion of ${parent}: ${unknown.join(', ')}.`);
  }

  return { ok: true, value: undefined };
};

const statusFactGate = async (
  input: CommandInput,
  ticket: CliTicket,
  status: TicketFrontMatter['status'] | undefined,
): Promise<Result<string | undefined, CliFailure>> => {
  if (status === undefined) {
    return { ok: true, value: undefined };
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const unshared = unsharedIdFailure(input.session, ticket.id);

  if (!unshared.ok) {
    return unshared;
  }

  return { ok: true, value: machine.value };
};

// Writes the file first, then the fact. A failed append leaves the file written.
export const writeTicketWithStatus = async (
  input: CommandInput,
  write: StatusWrite,
): Promise<Result<{ hash: string }, CliFailure>> => {
  const { ticket, frontMatter } = write;
  const status = frontMatter.status === ticket.frontMatter.status ? undefined : frontMatter.status;
  const gate = await statusFactGate(input, ticket, status);

  if (!gate.ok) {
    return gate;
  }

  const text = serializeTicketFile({ frontMatter, body: write.body ?? ticket.body });
  const written = await input.session.writeTicketFile(ticket.path, write.expectedHash, text);

  if (!written.ok) {
    const code = written.reason.kind === 'changedOnDisk' ? 'changedOnDisk' : 'storeError';

    return { ok: false, reason: { code, message: written.reason.message } };
  }

  const machine = gate.value;

  if (machine === undefined || status === undefined) {
    return written;
  }

  const fact: Fact = {
    version: 1,
    kind: 'status',
    ticket: ticket.id,
    at: input.effects.now().toISOString(),
    machine,
    status,
    ...(write.forced === undefined ? {} : { forced: write.forced }),
  };

  const appended = await input.session.appendFact(machine, fact);

  if (!appended.ok) {
    const message = `${ticket.path} was written, but the status fact was not appended: ${appended.reason.message}`;

    return { ok: false, reason: { code: 'storeError', message } };
  }

  return written;
};

export const writeTicketAndShow = async (
  input: CommandInput,
  write: StatusWrite,
): Promise<CommandResult> => {
  const written = await writeTicketWithStatus(input, write);

  if (!written.ok) {
    return written;
  }

  return showAfterRefresh(input.session, input.effects.now(), write.ticket.id);
};
