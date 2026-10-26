import { archiveDateOf } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { collectTicketTree, groupTicketChildren, serializeTicketFile } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { fileErrorFailure, refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { showAfterRefresh } from './ticketView.ts';

type ArchiveCommand = 'archive' | 'unarchive';

const changedTickets = (
  input: CommandInput,
  root: CliTicket,
  command: ArchiveCommand,
): CliTicket[] => {
  const children = groupTicketChildren(input.session.listTickets({ includeArchived: true }));
  const tree = collectTicketTree(root, children);
  const archiving = command === 'archive';

  return tree.filter((ticket) => (ticket.frontMatter.archived === undefined) === archiving);
};

const writeArchived = async (
  input: CommandInput,
  ticket: CliTicket,
  archived: string | undefined,
): Promise<Result<undefined, CliFailure>> => {
  const { archived: _previous, ...rest } = ticket.frontMatter;
  const frontMatter = archived === undefined ? rest : { ...rest, archived };
  const text = serializeTicketFile({ frontMatter, body: ticket.body });
  const written = await input.session.writeTicketFile(ticket.path, ticket.hash, text);

  if (!written.ok) {
    const code = written.reason.kind === 'changedOnDisk' ? 'changedOnDisk' : 'storeError';

    return { ok: false, reason: { code, message: written.reason.message } };
  }

  return { ok: true, value: undefined };
};

const appendUnarchive = async (
  input: CommandInput,
  machine: string,
  ticket: CliTicket,
): Promise<Result<undefined, CliFailure>> => {
  const fact: Fact = {
    version: 1,
    kind: 'unarchive',
    ticket: ticket.id,
    at: input.effects.now().toISOString(),
    machine,
  };

  const appended = await input.session.appendFact(machine, fact);

  if (!appended.ok) {
    const message = `${ticket.path} was written, but the unarchive fact was not appended: ${appended.reason.message}`;

    return { ok: false, reason: { code: 'storeError', message } };
  }

  return { ok: true, value: undefined };
};

const archiveTree = async (
  input: CommandInput,
  tickets: CliTicket[],
): Promise<Result<undefined, CliFailure>> => {
  const today = archiveDateOf(input.effects.now());

  for (const ticket of tickets) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A failed write stops the tickets after it.
    const written = await writeArchived(input, ticket, today);

    if (!written.ok) {
      return written;
    }
  }

  return { ok: true, value: undefined };
};

const unarchiveTicket = async (
  input: CommandInput,
  machine: string,
  ticket: CliTicket,
): Promise<Result<undefined, CliFailure>> => {
  const written = await writeArchived(input, ticket, undefined);

  if (!written.ok) {
    return written;
  }

  return appendUnarchive(input, machine, ticket);
};

// Each cleared ticket gets an unarchive fact, so the sweep does not archive it again for the same
// finish.
const unarchiveTree = async (
  input: CommandInput,
  tickets: CliTicket[],
): Promise<Result<undefined, CliFailure>> => {
  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  for (const ticket of tickets) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A failure stops the tickets after it.
    const unarchived = await unarchiveTicket(input, machine.value, ticket);

    if (!unarchived.ok) {
      return unarchived;
    }
  }

  return { ok: true, value: undefined };
};

const changeLocked = async (
  input: CommandInput,
  root: CliTicket,
  command: ArchiveCommand,
): Promise<CommandResult> => {
  const tickets = changedTickets(input, root, command);
  const broken = tickets.find((ticket) => ticket.error !== null);

  if (broken !== undefined) {
    return fileErrorFailure(broken);
  }

  const changed =
    command === 'archive' ? await archiveTree(input, tickets) : await unarchiveTree(input, tickets);

  if (!changed.ok) {
    return changed;
  }

  return showAfterRefresh(input.session, input.effects.now(), root.id);
};

const changeArchive = (input: CommandInput, command: ArchiveCommand): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return Promise.resolve(parsed);
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return Promise.resolve(invalidArguments(`Usage: tikk ${command} <id> [--json]`));
  }

  return withLockedTicket(input, rawId, refuseFileErrors, (root) =>
    changeLocked(input, root, command),
  );
};

export const ticketArchive = (input: CommandInput): Promise<CommandResult> =>
  changeArchive(input, 'archive');

export const ticketUnarchive = (input: CommandInput): Promise<CommandResult> =>
  changeArchive(input, 'unarchive');
