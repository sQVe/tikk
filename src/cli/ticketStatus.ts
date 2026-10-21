import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { checkTicketTree } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketLookup } from '../ticket/ticket.ts';
import { invalidArguments } from './cliArguments.ts';
import type {
  CliFailure,
  CliSession,
  CliTicket,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { fileErrorFailure, withStoreLock } from './taskLock.ts';
import { findTicket, storeFailure } from './ticketView.ts';

type Status = CliTicket['frontMatter']['status'];

interface StatusWrite {
  expectedHash: string;
  text: string;
  // The status fact to append after the write. Absent when the status does not change.
  status: Status | undefined;
  ticket: CliTicket;
}

export const resolveMachine = async (input: CommandInput): Promise<Result<string, CliFailure>> => {
  const machine = await input.effects.resolveMachine();

  if (!machine.ok) {
    return invalidArguments(machine.reason.message);
  }

  return machine;
};

// Checks the parent and edge targets against the tickets in the cache.
export const checkSessionTree = (
  session: CliSession,
  frontMatter: TicketFrontMatter,
): Result<undefined, CliFailure> => {
  const lookup: TicketLookup = (id) => {
    const found = session.getTicket(id);

    return found.ok ? { kind: found.value.frontMatter.kind } : undefined;
  };

  const checked = checkTicketTree(frontMatter, lookup);

  if (!checked.ok) {
    return invalidArguments(checked.reason.message);
  }

  return checked;
};

// Writes the file first, then the fact. A failed append leaves the file written.
export const writeTicketWithStatus = async (
  input: CommandInput,
  write: StatusWrite,
): Promise<Result<{ hash: string }, CliFailure>> => {
  const { ticket, status } = write;
  const machine = status === undefined ? undefined : await resolveMachine(input);

  if (machine !== undefined && !machine.ok) {
    return machine;
  }

  const written = await input.session.writeTicketFile(ticket.path, write.expectedHash, write.text);

  if (!written.ok) {
    const code = written.reason.kind === 'changedOnDisk' ? 'changedOnDisk' : 'storeError';

    return { ok: false, reason: { code, message: written.reason.message } };
  }

  if (machine === undefined || status === undefined) {
    return written;
  }

  const fact: Fact = {
    version: 1,
    kind: 'status',
    ticket: ticket.id,
    at: input.effects.now().toISOString(),
    machine: machine.value,
    status,
  };

  const appended = await input.session.appendFact(machine.value, fact);

  if (!appended.ok) {
    const message = `${ticket.path} was written, but the status fact was not appended: ${appended.reason.message}`;

    return { ok: false, reason: { code: 'storeError', message } };
  }

  return written;
};

// A ticket whose file has an error is refused: the cache keeps its last good front matter, which a
// status change must not use.
export const withLockedTicket = (
  input: CommandInput,
  rawId: string,
  work: (ticket: CliTicket) => Promise<CommandResult>,
): Promise<CommandResult> =>
  withStoreLock(input, async () => {
    const refreshed = await input.session.refresh();

    if (!refreshed.ok) {
      return storeFailure(refreshed.reason.message);
    }

    const found = findTicket(input.session, rawId);

    if (!found.ok) {
      return found;
    }

    if (found.value.error !== null) {
      return fileErrorFailure(found.value);
    }

    return work(found.value);
  });
