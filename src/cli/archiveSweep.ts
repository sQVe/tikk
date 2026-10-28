import { findArchiveDue } from '../fact/fact.ts';
import type { ArchiveDue, Fact } from '../fact/fact.ts';
import { serializeTicketFile } from '../ticket/ticket.ts';
import type { CliEffects, CliSession } from './cliEffects.ts';

const hasWork = (due: ArchiveDue): boolean => due.archive.length > 0 || due.statusFacts.length > 0;

const findDue = async (
  effects: CliEffects,
  session: CliSession,
): Promise<ArchiveDue | undefined> => {
  const tickets = session.listTicketOutlines();
  const facts = await session.listArchiveFacts();

  if (!tickets.ok || !facts.ok) {
    return undefined;
  }

  return findArchiveDue(tickets.value, facts.value, effects.now());
};

const appendStatusFacts = async (
  effects: CliEffects,
  session: CliSession,
  due: ArchiveDue,
): Promise<void> => {
  const machine = await effects.resolveMachine();

  if (!machine.ok) {
    return;
  }

  for (const { ticket, status } of due.statusFacts) {
    const fact: Fact = {
      version: 1,
      kind: 'status',
      ticket,
      at: effects.now().toISOString(),
      machine: machine.value,
      status,
    };

    // oxlint-disable-next-line eslint/no-await-in-loop -- Appends to one fact file run one at a time.
    await session.appendFact(machine.value, fact);
  }
};

// A write that fails or finds the file changed leaves that ticket for a later sweep. The IDs come
// from outlines of the same refresh, which leave out files with an error.
const writeArchived = async (session: CliSession, due: ArchiveDue): Promise<void> => {
  const writes = due.archive.map(async (id) => {
    const found = session.getTicket(id);

    if (found.ok) {
      const ticket = found.value;
      const frontMatter = { ...ticket.frontMatter, archived: due.date };
      const text = serializeTicketFile({ frontMatter, body: ticket.body });

      await session.writeTicketFile(ticket.path, ticket.hash, text);
    }
  });

  await Promise.all(writes);
};

const sweepLocked = async (effects: CliEffects, session: CliSession): Promise<void> => {
  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return;
  }

  const due = await findDue(effects, session);

  if (due === undefined) {
    return;
  }

  await appendStatusFacts(effects, session, due);
  await writeArchived(session, due);
  await session.refresh();
};

// Archives finished work before a command runs. The sweep never fails the command: anything it
// cannot do now, a later command does.
export const sweepArchive = async (effects: CliEffects, session: CliSession): Promise<void> => {
  const mayHaveWork = session.mayHaveArchiveWork(effects.now());

  if (!mayHaveWork.ok || !mayHaveWork.value) {
    return;
  }

  const due = await findDue(effects, session);

  if (due === undefined || !hasWork(due)) {
    return;
  }

  const lock = await session.tryLockStore();

  if (!lock.ok) {
    return;
  }

  try {
    await sweepLocked(effects, session);
  } finally {
    await lock.value.release();
  }
};
