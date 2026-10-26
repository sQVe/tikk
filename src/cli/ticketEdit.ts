import type { Result } from '../result.ts';
import { parseTicketId, ticketFrontMatterSchema, withoutNew } from '../ticket/ticket.ts';
import type { TicketFrontMatter } from '../ticket/ticket.ts';
import {
  invalidArguments,
  listValue,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { readCriteriaFile } from './ticketCriteria.ts';
import { ticketEditor } from './ticketEditor.ts';
import {
  checkCovers,
  checkSessionTree,
  checkWaitCycle,
  writeTicketAndShow,
} from './ticketStatus.ts';

interface FieldEdit {
  hash: string;
  title: string | undefined;
  status: string | undefined;
  kind: string | undefined;
  parent: string | undefined;
  bodyPath: string | undefined;
  criteriaPath: string | undefined;
  covers: string[] | undefined;
  clearCovers: boolean;
}

const usage =
  'Usage: tikk edit <id> --hash <hash> [--title <t>] [--status <s>] [--kind <slice|plan>] [--parent <id>] [--criteria-file <f>] [--body-file <f>] [--covers <criterion>]... [--clear-covers] --json, or tikk edit <id>';

const kindChange = (
  ticket: CliTicket,
  edit: FieldEdit,
): Result<TicketFrontMatter['kind'], CliFailure> => {
  const { kind: current } = ticket.frontMatter;
  const { kind, parent } = edit;

  if (parent !== undefined && kind !== 'slice') {
    return invalidArguments('--parent is only allowed with --kind slice.');
  }

  if (kind === undefined) {
    return { ok: true, value: current };
  }

  if (kind !== 'slice' && kind !== 'plan') {
    return invalidArguments(`The kind of a ticket can only change to slice or plan, not ${kind}.`);
  }

  if (current !== 'task') {
    return invalidArguments(
      `Ticket ${ticket.id} is a ${current}, and only a task can change its kind.`,
    );
  }

  if (ticket.frontMatter.parent !== undefined) {
    return invalidArguments(
      `Ticket ${ticket.id} has a parent, and only a loose task can change its kind.`,
    );
  }

  if (ticket.frontMatter.status !== 'open') {
    return invalidArguments(
      `Ticket ${ticket.id} is ${ticket.frontMatter.status}, so it cannot change its kind.`,
    );
  }

  return { ok: true, value: kind };
};

const parentChange = (edit: FieldEdit): Result<TicketFrontMatter['parent'], CliFailure> => {
  if (edit.parent === undefined) {
    return { ok: true, value: undefined };
  }

  const parent = parseTicketId(edit.parent);

  if (!parent.ok) {
    return invalidArguments(parent.reason.message);
  }

  return parent;
};

const coversChange = (current: TicketFrontMatter, edit: FieldEdit): string[] | undefined => {
  if (edit.clearCovers) {
    return undefined;
  }

  return edit.covers ?? current.covers;
};

const buildFrontMatter = (
  ticket: CliTicket,
  edit: FieldEdit,
  criteria: unknown,
): Result<TicketFrontMatter, CliFailure> => {
  const kind = kindChange(ticket, edit);

  if (!kind.ok) {
    return kind;
  }

  const parent = parentChange(edit);

  if (!parent.ok) {
    return parent;
  }

  const status = edit.status ?? ticket.frontMatter.status;
  const keepsNew = kind.value === 'task' && status === 'open';
  const current = keepsNew ? ticket.frontMatter : withoutNew(ticket.frontMatter);

  const covers = coversChange(current, edit);

  const frontMatter = ticketFrontMatterSchema.safeParse({
    ...current,
    kind: kind.value,
    parent: parent.value ?? current.parent,
    title: edit.title ?? current.title,
    status,
    criteria: criteria ?? current.criteria,
    covers,
  });

  if (!frontMatter.success) {
    return invalidArguments(frontMatter.error.issues.map((issue) => issue.message).join('\n'));
  }

  return { ok: true, value: frontMatter.data };
};

const applyEdit = async (
  input: CommandInput,
  ticket: CliTicket,
  edit: FieldEdit,
): Promise<CommandResult> => {
  const criteria = await readCriteriaFile(input.effects, edit.criteriaPath);

  if (!criteria.ok) {
    return criteria;
  }

  const frontMatter = buildFrontMatter(ticket, edit, criteria.value);

  if (!frontMatter.ok) {
    return frontMatter;
  }

  const tree = checkSessionTree(input.session, frontMatter.value);

  if (!tree.ok) {
    return tree;
  }

  const { parent } = frontMatter.value;
  const changesParent = parent !== undefined && parent !== ticket.frontMatter.parent;

  if (changesParent) {
    const acyclic = checkWaitCycle(input.session, ticket.id, parent);

    if (!acyclic.ok) {
      return acyclic;
    }
  }

  const givenCovers = edit.covers ?? [];
  const covers = checkCovers(input.session, ticket.id, givenCovers, frontMatter.value.parent);

  if (!covers.ok) {
    return covers;
  }

  const body =
    edit.bodyPath === undefined
      ? { ok: true as const, value: ticket.body }
      : await readBodyFile(input.effects, edit.bodyPath);

  if (!body.ok) {
    return body;
  }

  return writeTicketAndShow(input, {
    ticket,
    expectedHash: edit.hash,
    frontMatter: frontMatter.value,
    body: body.value,
  });
};

const readFieldEdit = (
  values: ParsedArguments['values'],
  json: boolean,
): Result<FieldEdit | undefined, CliFailure> => {
  const title = stringValue(values, 'title');
  const status = stringValue(values, 'status');
  const kind = stringValue(values, 'kind');
  const parent = stringValue(values, 'parent');
  const bodyPath = stringValue(values, 'body-file');
  const criteriaPath = stringValue(values, 'criteria-file');
  const hash = stringValue(values, 'hash');
  const covers = listValue(values, 'covers');
  const coversGiven = covers.length > 0 ? covers : undefined;
  const clearCovers = values['clear-covers'] === true;

  if (coversGiven !== undefined && clearCovers) {
    return invalidArguments('Give --covers or --clear-covers, not both.');
  }

  const fields = [title, status, kind, parent, bodyPath, criteriaPath];

  const hasField =
    fields.some((field) => field !== undefined) || coversGiven !== undefined || clearCovers;

  if (!hasField && json) {
    return invalidArguments(
      `Give at least one of --title, --status, --kind, --parent, --criteria-file, --body-file, --covers, or --clear-covers. ${usage}`,
    );
  }

  if (!hasField) {
    return { ok: true, value: undefined };
  }

  if (hash === undefined) {
    return invalidArguments(`Give --hash. ${usage}`);
  }

  return {
    ok: true,
    value: {
      hash,
      title,
      status,
      kind,
      parent,
      bodyPath,
      criteriaPath,
      covers: coversGiven,
      clearCovers,
    },
  };
};

export const ticketEdit = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    hash: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    kind: { type: 'string' },
    parent: { type: 'string' },
    'criteria-file': { type: 'string' },
    'body-file': { type: 'string' },
    covers: { type: 'string', multiple: true },
    'clear-covers': { type: 'boolean' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  const edit = readFieldEdit(parsed.value.values, input.json);

  if (!edit.ok) {
    return edit;
  }

  if (edit.value === undefined) {
    return ticketEditor(input, rawId);
  }

  const fieldEdit = edit.value;

  return withLockedTicket(input, rawId, refuseFileErrors, (ticket) =>
    applyEdit(input, ticket, fieldEdit),
  );
};
