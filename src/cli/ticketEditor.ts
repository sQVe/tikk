import { parseTicketId } from '../ticket/ticket.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { showAfterRefresh, storeFailure } from './ticketView.ts';

const missingTicket = (rawId: string): CommandResult => ({
  ok: false,
  reason: { code: 'notFound', message: `Ticket ${rawId} does not exist.` },
});

export const ticketEditor = async (input: CommandInput, rawId: string): Promise<CommandResult> => {
  const id = parseTicketId(rawId);

  if (!id.ok) {
    return missingTicket(rawId);
  }

  const path = input.session.findTicketPath(id.value);

  if (!path.ok) {
    return missingTicket(rawId);
  }

  // The editor runs until the user exits it. A caller that must stop it wraps runEditor.
  const edited = await input.effects.runEditor(path.value, new AbortController().signal);

  if (!edited.ok) {
    return storeFailure(edited.reason.message);
  }

  await input.effects.scheduleSync();

  return showAfterRefresh(input.session, input.effects.now(), id.value);
};
