import { buildSliceIndex, deriveSliceState, deriveInstructionState } from '../fact/fact.ts';
import type {
  SliceState,
  InstructionClaim,
  InstructionRejection,
  InstructionState,
  InstructionStateName,
  TreeStateName,
} from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliFailure, CliSession, CliTicket, CommandResult } from './cliEffects.ts';

type Criterion = NonNullable<CliTicket['frontMatter']['criteria']>[number];

export interface TicketView {
  id: string;
  path: string;
  hash: string;
  kind: CliTicket['frontMatter']['kind'];
  title: string;
  project: string;
  parent: string | null;
  rank: number | null;
  blockedBy: string[];
  discoveredFrom: string[];
  related: string[];
  criteria: Criterion[] | null;
  covers: string[] | null;
  status: string;
  archived: string | null;
  body?: string;
  new?: true;
  error: string | null;
}

export interface InstructionView extends TicketView {
  state: InstructionStateName;
  claim: InstructionClaim | null;
  rejection: InstructionRejection | null;
}

interface SliceView extends TicketView, SliceState {}

export interface TicketChild {
  id: TicketId;
  kind: CliTicket['frontMatter']['kind'];
  title: string;
}

export type ShownState =
  | { kind: 'slice'; derived: SliceState }
  | { kind: 'instruction'; derived: InstructionState }
  | { kind: 'status'; state: CliTicket['frontMatter']['status'] };

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
    discoveredFrom: frontMatter.discoveredFrom,
    related: frontMatter.related,
    criteria: frontMatter.criteria ?? null,
    covers: frontMatter.covers ?? null,
    status: frontMatter.status,
    archived: frontMatter.archived ?? null,
    error: ticket.error,
  };

  if (withBody) {
    view.body = ticket.body;
  }

  if (frontMatter.new === true) {
    view.new = true;
  }

  return view;
};

const instructionView = (ticket: CliTicket, derived: InstructionState): InstructionView => ({
  ...ticketView(ticket, true),
  state: derived.state,
  claim: derived.claim,
  rejection: derived.rejection,
});

export const instructionOutput = (ticket: CliTicket, derived: InstructionState): CommandResult => ({
  ok: true,
  value: {
    json: instructionView(ticket, derived),
    text: `${ticket.id}  ${derived.state}  ${ticket.frontMatter.title}\n`,
  },
});

export const instructionItemOutput = (
  ticket: CliTicket,
  derived: InstructionState,
  item: string,
): CommandResult => ({
  ok: true,
  value: {
    json: { ...instructionView(ticket, derived), item },
    text: `${ticket.id}  ${derived.state}  ${item}  ${ticket.frontMatter.title}\n`,
  },
});

export const ticketText = (ticket: CliTicket, state: string): string => {
  const heading = `${ticket.id}  ${state}  ${ticket.frontMatter.title}`;

  if (ticket.error === null) {
    return `${heading}\n${ticket.body}`;
  }

  return `${heading}\nerror: ${ticket.path}: ${ticket.error}\n${ticket.body}`;
};

export const storeFailure = (message: string): CommandResult => ({
  ok: false,
  reason: { code: 'storeError', message },
});

const storeError = (message: string): CliFailure => ({ code: 'storeError', message });

const deriveSlice = async (
  session: CliSession,
  now: Date,
  ticket: CliTicket,
): Promise<Result<ShownState, CliFailure>> => {
  const listed = session.listTicketOutlines();

  if (!listed.ok) {
    return { ok: false, reason: storeError(listed.reason.message) };
  }

  const outlines = listed.value;

  const instructionIds = outlines
    .filter((outline) => outline.frontMatter.parent === ticket.id)
    .map((outline) => outline.id);

  const facts = await session.listStateFacts([ticket.id, ...instructionIds]);

  if (!facts.ok) {
    return { ok: false, reason: storeError(facts.reason.message) };
  }

  const derived = deriveSliceState(ticket, buildSliceIndex(outlines, facts.value), now);

  return { ok: true, value: { kind: 'slice', derived } };
};

export const deriveShownState = async (
  session: CliSession,
  now: Date,
  ticket: CliTicket,
): Promise<Result<ShownState, CliFailure>> => {
  const { kind, status } = ticket.frontMatter;

  if (kind === 'slice' && status === 'open') {
    return deriveSlice(session, now, ticket);
  }

  if (kind !== 'instruction') {
    return { ok: true, value: { kind: 'status', state: status } };
  }

  const facts = await session.listStateFacts([ticket.id]);

  if (!facts.ok) {
    return { ok: false, reason: storeError(facts.reason.message) };
  }

  return {
    ok: true,
    value: { kind: 'instruction', derived: deriveInstructionState(ticket, facts.value, now) },
  };
};

export const shownStateName = (shown: ShownState): TreeStateName =>
  shown.kind === 'status' ? shown.state : shown.derived.state;

export const ticketChildrenOf = (
  session: CliSession,
  id: TicketId,
): Result<TicketChild[], CliFailure> => {
  const listed = session.listTicketOutlines();

  if (!listed.ok) {
    return { ok: false, reason: storeError(listed.reason.message) };
  }

  const children = listed.value
    .filter((outline) => outline.frontMatter.parent === id)
    .filter((outline) => outline.frontMatter.archived === undefined)
    .map((outline) => ({
      id: outline.id,
      kind: outline.frontMatter.kind,
      title: outline.frontMatter.title,
    }));

  return { ok: true, value: children };
};

const shownView = (ticket: CliTicket, shown: ShownState): TicketView => {
  if (shown.kind === 'slice') {
    const view: SliceView = { ...ticketView(ticket, true), ...shown.derived };

    return view;
  }

  return shown.kind === 'instruction'
    ? instructionView(ticket, shown.derived)
    : ticketView(ticket, true);
};

const showKind = async (
  session: CliSession,
  now: Date,
  ticket: CliTicket,
  files: string[],
): Promise<CommandResult> => {
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
      json: {
        ...shownView(ticket, shown.value),
        children: children.value,
        files,
      },
      text: ticketText(ticket, shownStateName(shown.value)),
    },
  };
};

export const showOutput = async (
  session: CliSession,
  now: Date,
  ticket: CliTicket,
): Promise<CommandResult> => {
  const folder = await session.listTicketFolderFiles(ticket.frontMatter.project, ticket.id);

  if (!folder.ok) {
    return storeFailure(folder.reason.message);
  }

  return showKind(session, now, ticket, folder.value);
};

export const showAfterRefresh = async (
  session: CliSession,
  now: Date,
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

  return showOutput(session, now, ticket.value);
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

  if (ticket.reason.kind === 'failed') {
    return { ok: false, reason: { code: 'storeError', message: ticket.reason.message } };
  }

  const path = session.findTicketPath(id.value);

  if (!path.ok && path.reason.kind === 'failed') {
    return { ok: false, reason: { code: 'storeError', message: path.reason.message } };
  }

  if (!path.ok) {
    return { ok: false, reason: notFound };
  }

  const errors = session.listErrors();

  if (!errors.ok) {
    return { ok: false, reason: { code: 'storeError', message: errors.reason.message } };
  }

  const cached = errors.value.find((error) => error.path === path.value);
  const detail = cached?.message ?? 'The file did not parse.';

  return {
    ok: false,
    reason: { code: 'parseError', message: `${path.value} has an error: ${detail}` },
  };
};
