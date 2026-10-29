import type { Result } from '../result.ts';
import type { TicketId } from './ticketId.ts';
import type { TicketFrontMatter } from './ticketSchema.ts';

interface TreeFailure {
  message: string;
}

type TicketKind = TicketFrontMatter['kind'];

export type TicketLookup = (
  id: TicketId,
) => { kind: TicketKind; hasFileError: boolean } | undefined;

interface TreeTicket {
  id: TicketId;
  frontMatter: { parent?: TicketId | undefined };
}

interface WaitTicket {
  id: TicketId;
  frontMatter: { parent?: TicketId | undefined; blockedBy: TicketId[] };
}

const allowedParentKinds: Record<TicketKind, TicketKind[]> = {
  plan: [],
  slice: ['plan'],
  task: ['plan', 'slice'],
  instruction: ['slice'],
};

export const isAllowedParentKind = (kind: TicketKind, parentKind: TicketKind): boolean =>
  allowedParentKinds[kind].includes(parentKind);

const fail = (message: string): { ok: false; reason: TreeFailure } => ({
  ok: false,
  reason: { message },
});

const withArticle = (word: string): string => (/^[aeiou]/u.test(word) ? `an ${word}` : `a ${word}`);

const checkParent = (
  planned: TicketFrontMatter,
  lookup: TicketLookup,
): Result<undefined, TreeFailure> => {
  const { parent, kind } = planned;

  if (parent === undefined) {
    if (kind === 'instruction') {
      return fail('An instruction needs a slice as its parent.');
    }

    return { ok: true, value: undefined };
  }

  const allowedKinds = allowedParentKinds[kind];

  if (allowedKinds.length === 0) {
    return fail(`A ${kind} has no parent, but the parent is ${parent}.`);
  }

  const found = lookup(parent);

  if (found === undefined) {
    return fail(`The parent ${parent} does not exist.`);
  }

  if (found.hasFileError) {
    return fail(`The parent ${parent} has a file error. Fix it first.`);
  }

  if (!allowedKinds.includes(found.kind)) {
    const allowed = allowedKinds.map(withArticle).join(' or ');

    return fail(
      `The parent ${parent} is ${withArticle(found.kind)}, but the parent of ${withArticle(kind)} must be ${allowed}.`,
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
    const found = lookup(target);

    if (found === undefined) {
      return fail(`The ${name} target ${target} does not exist.`);
    }

    if (found.hasFileError) {
      return fail(`The ${name} target ${target} has a file error. Fix it first.`);
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

const waitTargets = (ticket: WaitTicket): TicketId[] => {
  const { parent, blockedBy } = ticket.frontMatter;

  return parent === undefined ? blockedBy : [...blockedBy, parent];
};

const pathTo = (end: TicketId, previous: Map<TicketId, TicketId>): TicketId[] => {
  const path = [end];

  for (let step = previous.get(end); step !== undefined; step = previous.get(step)) {
    path.unshift(step);
  }

  return path;
};

export const findWaitCycle = (
  tickets: WaitTicket[],
  from: TicketId,
  to: TicketId,
): TicketId[] | undefined => {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  const previous = new Map<TicketId, TicketId>();
  const seen = new Set<TicketId>([to]);
  const pending = [to];

  for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
    if (id === from) {
      return [from, ...pathTo(id, previous)];
    }

    const ticket = byId.get(id);
    const targets = ticket === undefined ? [] : waitTargets(ticket);

    for (const target of targets) {
      if (!seen.has(target)) {
        seen.add(target);
        previous.set(target, id);
        pending.push(target);
      }
    }
  }

  return undefined;
};
