import type { Result } from '../result.ts';
import { parseTicketId, serializeTicketFile, ticketFrontMatterSchema } from '../ticket/ticket.ts';
import type { TicketFrontMatter } from '../ticket/ticket.ts';
import {
  invalidArguments,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { fileErrorFailure, withStoreLock } from './taskLock.ts';
import { checkSessionTree, writeTicketWithStatus } from './ticketStatus.ts';
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

interface FieldEdit {
  hash: string;
  title: string | undefined;
  status: string | undefined;
  kind: string | undefined;
  parent: string | undefined;
  bodyPath: string | undefined;
}

const usage =
  'Usage: tikk edit <id> --hash <hash> [--title <t>] [--status <s>] [--kind <slice|plan>] [--parent <id>] [--body-file <f>] --json, or tikk edit <id>';

const missingTicket = (rawId: string): CommandResult => ({
  ok: false,
  reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` },
});

const editInEditor = async (input: CommandInput, rawId: string): Promise<CommandResult> => {
  const id = parseTicketId(rawId);

  if (!id.ok) {
    return missingTicket(rawId);
  }

  const path = input.session.findTicketPath(id.value);

  if (!path.ok) {
    return missingTicket(rawId);
  }

  const edited = await input.effects.runEditor(path.value);

  if (!edited.ok) {
    return storeFailure(edited.reason.message);
  }

  return showAfterRefresh(input.session, input.effects.now(), id.value);
};

const kindChange = (
  ticket: CliTicket,
  edit: FieldEdit,
): Result<TicketFrontMatter['kind'], CliFailure> => {
  const { kind: current } = ticket.frontMatter;
  const { kind, parent } = edit;

  if (kind === undefined && parent !== undefined) {
    return invalidArguments('--parent is only allowed with --kind slice.');
  }

  if (kind === undefined) {
    return { ok: true, value: current };
  }

  if (kind !== 'slice' && kind !== 'plan') {
    return invalidArguments(`The kind of a ticket can only change to slice or plan, not ${kind}.`);
  }

  if (current !== 'issue') {
    return invalidArguments(
      `Ticket ${ticket.id} is a ${current}, and only an issue can change its kind.`,
    );
  }

  if (parent !== undefined && kind !== 'slice') {
    return invalidArguments('--parent is only allowed with --kind slice.');
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
): Result<TicketFrontMatter, CliFailure> => {
  const kind = kindChange(ticket, edit);

  if (!kind.ok) {
    return kind;
  }

  const parent = parentChange(edit);

  if (!parent.ok) {
    return parent;
  }

  const frontMatter = ticketFrontMatterSchema.safeParse({
    ...ticket.frontMatter,
    kind: kind.value,
    parent: parent.value ?? ticket.frontMatter.parent,
    title: edit.title ?? ticket.frontMatter.title,
    status: edit.status ?? ticket.frontMatter.status,
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
  if (ticket.error !== null) {
    return fileErrorFailure(ticket);
  }

  const frontMatter = buildFrontMatter(ticket, edit);

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

  const text = serializeTicketFile({ frontMatter: frontMatter.value, body: body.value });
  const changesStatus = frontMatter.value.status !== ticket.frontMatter.status;

  const written = await writeTicketWithStatus(input, {
    expectedHash: edit.hash,
    text,
    status: changesStatus ? frontMatter.value.status : undefined,
    ticket,
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
  const hash = stringValue(values, 'hash');
  const hasField = [title, status, kind, parent, bodyPath].some((field) => field !== undefined);

  if (!hasField && json) {
    return invalidArguments(
      `Give at least one of --title, --status, --kind, --parent, or --body-file. ${usage}`,
    );
  }

  if (!hasField) {
    return { ok: true, value: undefined };
  }

  if (hash === undefined) {
    return invalidArguments(`Give --hash. ${usage}`);
  }

  return { ok: true, value: { hash, title, status, kind, parent, bodyPath } };
};

export const ticketEdit = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    hash: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    kind: { type: 'string' },
    parent: { type: 'string' },
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
    return editInEditor(input, rawId);
  }

  const fieldEdit = edit.value;

  return withStoreLock(input, async () => {
    const refreshed = await input.session.refresh();

    if (!refreshed.ok) {
      return storeFailure(refreshed.reason.message);
    }

    const found = findTicket(input.session, rawId);

    if (!found.ok) {
      return found;
    }

    return applyEdit(input, found.value, fieldEdit);
  });
};
