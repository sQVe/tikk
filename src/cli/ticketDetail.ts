import type { SliceState, TreeStateName } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { CliFailure, CliSession } from './cliEffects.ts';
import {
  deriveShownState,
  findTicket,
  shownStateName,
  ticketChildrenOf,
  ticketView,
} from './ticketView.ts';
import type { TicketChild, TicketView } from './ticketView.ts';

export interface TicketDetail {
  ticket: TicketView;
  body: string;
  state: TreeStateName;
  pr: SliceState['pr'];
  children: TicketChild[];
}

export const readTicketDetail = async (
  session: CliSession,
  now: Date,
  rawId: string,
): Promise<Result<TicketDetail, CliFailure>> => {
  const found = findTicket(session, rawId);

  if (!found.ok) {
    return found;
  }

  const ticket = found.value;
  const shown = await deriveShownState(session, now, ticket);

  if (!shown.ok) {
    return shown;
  }

  const children = ticketChildrenOf(session, ticket.id);

  if (!children.ok) {
    return children;
  }

  return {
    ok: true,
    value: {
      ticket: ticketView(ticket, false),
      body: ticket.body,
      state: shownStateName(shown.value),
      pr: shown.value.kind === 'slice' ? shown.value.derived.pr : null,
      children: children.value,
    },
  };
};
