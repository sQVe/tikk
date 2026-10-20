import type { TaskClaim, TaskStateName } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliFailure, CliSession, CliTicket, CommandResult } from './cliEffects.ts';

export interface TicketView {
  id: string;
  path: string;
  hash: string;
  kind: string;
  title: string;
  project: string;
  parent: string | null;
  rank: number | null;
  blockedBy: string[];
  status: string;
  archived: string | null;
  body?: string;
  error: string | null;
}

export interface TaskView extends TicketView {
  state: TaskStateName;
  claim: TaskClaim | null;
}

export const ticketView = (ticket: CliTicket, withBody: boolean): TicketView => {
  const { frontMatter } = ticket;

  const view: TicketView = {
    id: ticket.id,
    path: ticket.path,
    hash: ticket.hash,
    kind: frontMatter.kind,
    title: frontMatter.title,
    project: frontMatter.project,
    parent: frontMatter.parent ?? null,
    rank: frontMatter.rank ?? null,
    blockedBy: frontMatter.blockedBy,
    status: frontMatter.status,
    archived: frontMatter.archived ?? null,
    error: ticket.error,
  };

  if (withBody) {
    view.body = ticket.body;
  }

  return view;
};

export const taskView = (
  ticket: CliTicket,
  state: TaskStateName,
  claim: TaskClaim | null,
): TaskView => ({ ...ticketView(ticket, true), state, claim });

export const taskOutput = (
  ticket: CliTicket,
  state: TaskStateName,
  claim: TaskClaim | null,
): CommandResult => ({
  ok: true,
  value: {
    json: taskView(ticket, state, claim),
    text: `${ticket.id}  ${state}  ${ticket.frontMatter.title}\n`,
  },
});

export const ticketText = (ticket: CliTicket): string => {
  const heading = `${ticket.id}  ${ticket.frontMatter.status}  ${ticket.frontMatter.title}`;

  if (ticket.error === null) {
    return `${heading}\n${ticket.body}`;
  }

  return `${heading}\nerror: ${ticket.path}: ${ticket.error}\n${ticket.body}`;
};

export const storeFailure = (message: string): CommandResult => ({
  ok: false,
  reason: { code: 'storeError', message },
});

const showTicket = (ticket: CliTicket): CommandResult => ({
  ok: true,
  value: { json: ticketView(ticket, true), text: ticketText(ticket) },
});

export const showAfterRefresh = async (
  session: CliSession,
  id: TicketId,
): Promise<CommandResult> => {
  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return storeFailure(refreshed.reason.message);
  }

  const ticket = session.getTicket(id);

  if (!ticket.ok) {
    return storeFailure(ticket.reason.message);
  }

  return showTicket(ticket.value);
};

export const findTicket = (session: CliSession, rawId: string): Result<CliTicket, CliFailure> => {
  const id = parseTicketId(rawId);
  const notFound = { code: 'notFound', message: `Ticket ${rawId} does not exist.` } as const;

  if (!id.ok) {
    return { ok: false, reason: notFound };
  }

  const ticket = session.getTicket(id.value);

  if (ticket.ok) {
    return ticket;
  }

  const path = session.findTicketPath(id.value);

  if (!path.ok) {
    return { ok: false, reason: notFound };
  }

  const cached = session.listErrors().find((error) => error.path === path.value);
  const detail = cached?.message ?? 'The file did not parse.';

  return {
    ok: false,
    reason: { code: 'parseError', message: `${path.value} has an error: ${detail}` },
  };
};
