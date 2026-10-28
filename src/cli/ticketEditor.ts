import type { Result } from '../result.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

export type EditTarget = 'ticket' | 'design';

interface EditableFile {
  id: TicketId;
  path: string;
}

const missingTicket = (rawId: string): CliFailure => ({
  code: 'notFound',
  message: `Ticket ${rawId} does not exist.`,
});

const ticketFileOf = (input: CommandInput, rawId: string): Result<EditableFile, CliFailure> => {
  const id = parseTicketId(rawId);

  if (!id.ok) {
    return { ok: false, reason: missingTicket(rawId) };
  }

  const path = input.session.findTicketPath(id.value);

  if (!path.ok && path.reason.kind === 'failed') {
    return { ok: false, reason: { code: 'storeError', message: path.reason.message } };
  }

  if (!path.ok) {
    return { ok: false, reason: missingTicket(rawId) };
  }

  return { ok: true, value: { id: id.value, path: path.value } };
};

const designFileOf = async (
  input: CommandInput,
  rawId: string,
): Promise<Result<EditableFile, CliFailure>> => {
  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  const { id, frontMatter } = found.value;

  if (frontMatter.kind !== 'plan') {
    return invalidArguments(
      `Ticket ${id} is a ${frontMatter.kind}, and only a plan has a design.md.`,
    );
  }

  const path = input.session.designFilePath(frontMatter.project, id);
  const content = await input.effects.readTextFile(path);

  if (content === undefined) {
    return {
      ok: false,
      reason: { code: 'notFound', message: `${path} does not exist. Create it first.` },
    };
  }

  return { ok: true, value: { id, path } };
};

const editableFileOf = (
  input: CommandInput,
  rawId: string,
  target: EditTarget,
): Promise<Result<EditableFile, CliFailure>> => {
  if (target === 'design') {
    return designFileOf(input, rawId);
  }

  return Promise.resolve(ticketFileOf(input, rawId));
};

export const ticketEditor = async (
  input: CommandInput,
  rawId: string,
  target: EditTarget,
): Promise<CommandResult> => {
  const file = await editableFileOf(input, rawId, target);

  if (!file.ok) {
    return file;
  }

  // The editor runs until the user exits it. A caller that must stop it wraps runEditor.
  const edited = await input.effects.runEditor(file.value.path, new AbortController().signal);

  if (!edited.ok) {
    return storeFailure(edited.reason.message);
  }

  await input.effects.scheduleSync();

  return showAfterRefresh(input.session, input.effects.now(), file.value.id);
};
