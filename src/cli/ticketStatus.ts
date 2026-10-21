import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { checkTicketTree, serializeTicketFile } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketLookup } from '../ticket/ticket.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CliFailure, CliSession, CliTicket, CommandInput } from './cliEffects.ts';

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
  const lookup: TicketLookup = (id) => {
    const found = session.getTicket(id);

    if (!found.ok) {
      return undefined;
    }

    return { kind: found.value.frontMatter.kind, hasFileError: found.value.error !== null };
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
  const { ticket, frontMatter } = write;
  const status = frontMatter.status === ticket.frontMatter.status ? undefined : frontMatter.status;
  const machine = status === undefined ? undefined : await resolveMachine(input);

  if (machine !== undefined && !machine.ok) {
    return machine;
  }

  const text = serializeTicketFile({ frontMatter, body: write.body ?? ticket.body });
  const written = await input.session.writeTicketFile(ticket.path, write.expectedHash, text);

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
    ...(write.forced === undefined ? {} : { forced: write.forced }),
  };

  const appended = await input.session.appendFact(machine.value, fact);

  if (!appended.ok) {
    const message = `${ticket.path} was written, but the status fact was not appended: ${appended.reason.message}`;

    return { ok: false, reason: { code: 'storeError', message } };
  }

  return written;
};
