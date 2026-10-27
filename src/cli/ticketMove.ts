import type { Result } from '../result.ts';
import { parseTicketId, withoutNew } from '../ticket/ticket.ts';
import type { TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import {
  checkCovers,
  checkSessionTree,
  checkWaitCycle,
  writeTicketAndShow,
} from './ticketStatus.ts';
import { showOutput } from './ticketView.ts';

interface MoveArguments {
  rawId: string;
  parent: TicketId | undefined;
}

const usage =
  'Usage: tikk move <id> --parent <id> [--json], or tikk move <id> --no-parent [--json]';

const parseParent = (
  rawParent: string | undefined,
  noParent: boolean,
): Result<TicketId | undefined, CliFailure> => {
  if (rawParent !== undefined && noParent) {
    return invalidArguments(`Give --parent or --no-parent, not both. ${usage}`);
  }

  if (rawParent === undefined && !noParent) {
    return invalidArguments(`Give --parent or --no-parent. ${usage}`);
  }

  if (rawParent === undefined) {
    return { ok: true, value: undefined };
  }

  const parent = parseTicketId(rawParent);

  if (!parent.ok) {
    return invalidArguments(`The parent ${rawParent} is not a ticket ID. ${parent.reason.message}`);
  }

  return parent;
};

const parseMoveArguments = (input: CommandInput): Result<MoveArguments, CliFailure> => {
  const parsed = parseCommandArguments(input.args, {
    parent: { type: 'string' },
    'no-parent': { type: 'boolean' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  const { values } = parsed.value;
  const parent = parseParent(stringValue(values, 'parent'), values['no-parent'] === true);

  if (!parent.ok) {
    return parent;
  }

  return { ok: true, value: { rawId, parent: parent.value } };
};

const movedFrontMatter = (
  frontMatter: TicketFrontMatter,
  parent: TicketId | undefined,
): TicketFrontMatter => {
  if (parent !== undefined) {
    return withoutNew({ ...frontMatter, parent });
  }

  const loose = { ...frontMatter };

  delete loose.parent;

  return loose;
};

const moveTicket = async (
  input: CommandInput,
  ticket: CliTicket,
  parent: TicketId | undefined,
): Promise<CommandResult> => {
  if (ticket.frontMatter.parent === parent) {
    return showOutput(input.session, input.effects.now(), ticket);
  }

  const frontMatter = movedFrontMatter(ticket.frontMatter, parent);
  const tree = checkSessionTree(input.session, frontMatter);

  if (!tree.ok) {
    return tree;
  }

  if (parent !== undefined) {
    const acyclic = checkWaitCycle(input.session, ticket.id, parent);

    if (!acyclic.ok) {
      return acyclic;
    }
  }

  const storedCovers = ticket.frontMatter.covers ?? [];
  const covered = checkCovers(input.session, ticket.id, storedCovers, parent);

  if (!covered.ok) {
    return covered;
  }

  return writeTicketAndShow(input, { expectedHash: ticket.hash, ticket, frontMatter });
};

export const ticketMove = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseMoveArguments(input);

  if (!parsed.ok) {
    return parsed;
  }

  const { rawId, parent } = parsed.value;

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    moveTicket(input, ticket, parent),
  );
};
