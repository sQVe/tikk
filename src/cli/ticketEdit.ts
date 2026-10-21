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
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

interface FieldEdit {
  hash: string;
  title: string | undefined;
  status: string | undefined;
  bodyPath: string | undefined;
}

const usage =
  'Usage: tikk edit <id> --hash <hash> [--title <t>] [--status <s>] [--body-file <f>] --json, or tikk edit <id>';

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
    return fileErrorFailure(ticket);
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

  return showAfterRefresh(input.session, input.effects.now(), ticket.id);
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
