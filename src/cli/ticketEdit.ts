import type { Result } from '../result.ts';
import { parseTicketId, ticketFrontMatterSchema, withoutNew } from '../ticket/ticket.ts';
import type { TicketFrontMatter } from '../ticket/ticket.ts';
import {
  invalidArguments,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { readCriteriaFile } from './ticketCriteria.ts';
import { ticketEditor } from './ticketEditor.ts';
import { checkSessionTree, writeTicketWithStatus } from './ticketStatus.ts';
import { showAfterRefresh } from './ticketView.ts';

interface FieldEdit {
  hash: string;
  title: string | undefined;
  status: string | undefined;
  kind: string | undefined;
  parent: string | undefined;
  bodyPath: string | undefined;
  criteriaPath: string | undefined;
}

const usage =
  'Usage: tikk edit <id> --hash <hash> [--title <t>] [--status <s>] [--kind <slice|plan>] [--parent <id>] [--criteria-file <f>] [--body-file <f>] --json, or tikk edit <id>';

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

  const frontMatter = ticketFrontMatterSchema.safeParse({
    ...current,
    kind: kind.value,
    parent: parent.value ?? current.parent,
    title: edit.title ?? current.title,
    status,
    criteria: criteria ?? current.criteria,
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

  const body =
    edit.bodyPath === undefined
      ? { ok: true as const, value: ticket.body }
      : await readBodyFile(input.effects, edit.bodyPath);

  if (!body.ok) {
    return body;
  }

  const written = await writeTicketWithStatus(input, {
    ticket,
    expectedHash: edit.hash,
    frontMatter: frontMatter.value,
    body: body.value,
  });

  if (!written.ok) {
    return written;
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
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
  const fields = [title, status, kind, parent, bodyPath, criteriaPath];
  const hasField = fields.some((field) => field !== undefined);

  if (!hasField && json) {
    return invalidArguments(
      `Give at least one of --title, --status, --kind, --parent, --criteria-file, or --body-file. ${usage}`,
    );
  }

  if (!hasField) {
    return { ok: true, value: undefined };
  }

  if (hash === undefined) {
    return invalidArguments(`Give --hash. ${usage}`);
  }

  return { ok: true, value: { hash, title, status, kind, parent, bodyPath, criteriaPath } };
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
