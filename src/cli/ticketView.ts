import type { TicketId } from '../ticket/ticket.ts';
import type { CliSession, CliTicket, CommandResult } from './cliEffects.ts';

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

export const ticketText = (ticket: CliTicket): string => {
  const heading = `${ticket.id}  ${ticket.frontMatter.status}  ${ticket.frontMatter.title}`;

  return `${heading}\n${ticket.body}`;
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
