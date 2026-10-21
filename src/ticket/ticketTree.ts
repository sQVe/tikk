import type { Result } from '../result.ts';
import type { TicketId } from './ticketId.ts';
import type { TicketFrontMatter } from './ticketSchema.ts';

interface TreeFailure {
  message: string;
}

type TicketKind = TicketFrontMatter['kind'];

export type TicketLookup = (id: TicketId) => { kind: TicketKind } | undefined;

interface TreeTicket {
  id: TicketId;
  frontMatter: { parent?: TicketId | undefined };
}

const parentKinds: Record<TicketKind, TicketKind | undefined> = {
  plan: undefined,
  slice: 'plan',
  task: 'slice',
  issue: undefined,
};

const fail = (message: string): { ok: false; reason: TreeFailure } => ({
  ok: false,
  reason: { message },
});

const checkParent = (
  planned: TicketFrontMatter,
  lookup: TicketLookup,
): Result<undefined, TreeFailure> => {
  const { parent, kind } = planned;

  if (parent === undefined) {
    return { ok: true, value: undefined };
  }

  const allowedKind = parentKinds[kind];

  if (allowedKind === undefined) {
    return fail(`A ${kind} has no parent, but the parent is ${parent}.`);
  }

  const found = lookup(parent);

  if (found === undefined) {
    return fail(`The parent ${parent} does not exist.`);
  }

  if (found.kind !== allowedKind) {
    return fail(
      `The parent ${parent} is a ${found.kind}, but the parent of a ${kind} must be a ${allowedKind}.`,
    );
  }

  return { ok: true, value: undefined };
};

const checkEdges = (
  name: string,
  targets: TicketId[],
  lookup: TicketLookup,
): Result<undefined, TreeFailure> => {
  for (const target of targets) {
    if (lookup(target) === undefined) {
      return fail(`The ${name} target ${target} does not exist.`);
    }
  }

  return { ok: true, value: undefined };
};

export const checkTicketTree = (
  planned: TicketFrontMatter,
  lookup: TicketLookup,
): Result<undefined, TreeFailure> => {
  const parent = checkParent(planned, lookup);

  if (!parent.ok) {
    return parent;
  }

  const blockedBy = checkEdges('blockedBy', planned.blockedBy, lookup);

  if (!blockedBy.ok) {
    return blockedBy;
  }

  const discoveredFrom = checkEdges('discoveredFrom', planned.discoveredFrom, lookup);

  if (!discoveredFrom.ok) {
    return discoveredFrom;
  }

  return checkEdges('related', planned.related, lookup);
};

export const groupTicketChildren = <Ticket extends TreeTicket>(
  tickets: Ticket[],
): Map<TicketId, Ticket[]> => {
  const children = new Map<TicketId, Ticket[]>();

  for (const ticket of tickets) {
    const { parent } = ticket.frontMatter;

    if (parent !== undefined) {
      const siblings = children.get(parent) ?? [];

      siblings.push(ticket);
      children.set(parent, siblings);
    }
  }

  return children;
};

// The root first, then its descendants. A parent cycle in hand-edited files visits each ticket once.
export const collectTicketTree = <Ticket extends TreeTicket>(
  root: Ticket,
  children: Map<TicketId, Ticket[]>,
): Ticket[] => {
  const tree: Ticket[] = [];
  const seen = new Set<TicketId>();
  const pending = [root];

  for (let ticket = pending.shift(); ticket !== undefined; ticket = pending.shift()) {
    if (!seen.has(ticket.id)) {
      seen.add(ticket.id);
      tree.push(ticket);
      pending.push(...(children.get(ticket.id) ?? []));
    }
  }

  return tree;
};
