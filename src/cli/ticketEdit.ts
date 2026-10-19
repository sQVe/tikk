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
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

interface FieldEdit {
  hash: string;
  title: string | undefined;
  status: string | undefined;
  bodyPath: string | undefined;
}

const usage =
  'Usage: tikk edit <id> --hash <hash> [--title <t>] [--status <s>] [--body-file <f>] --json, or tikk edit <id>';

const editInEditor = async (input: CommandInput, rawId: string): Promise<CommandResult> => {
  const id = parseTicketId(rawId);
  const path = id.ok ? input.session.findTicketPath(id.value) : undefined;

  if (!id.ok || path === undefined || !path.ok) {
    return { ok: false, reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` } };
  }

  const edited = await input.effects.runEditor(path.value);

  if (!edited.ok) {
    return storeFailure(edited.reason.message);
  }

  return showAfterRefresh(input.session, id.value);
};

const buildFrontMatter = (
  ticket: CliTicket,
  edit: FieldEdit,
): Result<TicketFrontMatter, CliFailure> => {
  const frontMatter = ticketFrontMatterSchema.safeParse({
    ...ticket.frontMatter,
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
    return {
      ok: false,
      reason: { code: 'parseError', message: `${ticket.path} has an error: ${ticket.error}` },
    };
  }

  const frontMatter = buildFrontMatter(ticket, edit);

  if (!frontMatter.ok) {
    return frontMatter;
  }

  const body =
    edit.bodyPath === undefined
      ? { ok: true as const, value: ticket.body }
      : await readBodyFile(input.effects, edit.bodyPath);

  if (!body.ok) {
    return body;
  }

  const text = serializeTicketFile({ frontMatter: frontMatter.value, body: body.value });
  const written = await input.session.writeTicketFile(ticket.path, edit.hash, text);

  if (!written.ok) {
    const code = written.reason.kind === 'changedOnDisk' ? 'changedOnDisk' : 'storeError';

    return { ok: false, reason: { code, message: written.reason.message } };
  }

  return showAfterRefresh(input.session, ticket.id);
};

const readFieldEdit = (
  values: ParsedArguments['values'],
  json: boolean,
): Result<FieldEdit | undefined, CliFailure> => {
  const title = stringValue(values, 'title');
  const status = stringValue(values, 'status');
  const bodyPath = stringValue(values, 'body-file');
  const hash = stringValue(values, 'hash');
  const hasField = title !== undefined || status !== undefined || bodyPath !== undefined;

  if (!hasField && json) {
    return invalidArguments(`Give at least one of --title, --status, or --body-file. ${usage}`);
  }

  if (!hasField) {
    return { ok: true, value: undefined };
  }

  if (hash === undefined) {
    return invalidArguments(`Give --hash. ${usage}`);
  }

  return { ok: true, value: { hash, title, status, bodyPath } };
};

export const ticketEdit = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    hash: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
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

  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  return applyEdit(input, found.value, edit.value);
};
