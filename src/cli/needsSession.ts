import { buildPlanTree } from '../fact/fact.ts';
import type { TreeGroup } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { CliEffects, CliFailure } from './cliEffects.ts';
import { readNeeds } from './needsCommand.ts';
import type { NeedsReading } from './needsCommand.ts';
import { refreshSession } from './sessionRefresh.ts';
import { ticketEditor } from './ticketEditor.ts';

export interface NeedsSession {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<TreeGroup[], CliFailure>>;
  // Opens the ticket file in $EDITOR in the current terminal, like `tikk edit` does.
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  // Stops running work, waits for it to settle, then releases the session.
  close: () => Promise<void>;
}

// One session stays open for the TUI's lifetime. Each load reads like `tikk needs --json` does, and each tree load reads the plan tree.
export const openNeedsSession = async (
  effects: CliEffects,
): Promise<Result<NeedsSession, CliFailure>> => {
  const opened = await effects.openSession();

  if (!opened.ok) {
    return { ok: false, reason: opened.reason };
  }

  const session = opened.value;
  const closing = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let previous: Promise<unknown> = Promise.resolve();

  const loadEffects: CliEffects = {
    ...effects,
    runGh: (args, signal) => effects.runGh(args, AbortSignal.any([signal, closing.signal])),
    runEditor: (path, signal) => effects.runEditor(path, AbortSignal.any([signal, closing.signal])),
  };

  const read = async (): Promise<Result<NeedsReading, CliFailure>> => {
    const refreshed = await refreshSession(loadEffects, session);

    if (!refreshed.ok) {
      return refreshed;
    }

    return readNeeds({ effects: loadEffects, session });
  };

  const readTree = async (): Promise<Result<TreeGroup[], CliFailure>> => {
    const refreshed = await refreshSession(loadEffects, session);

    if (!refreshed.ok) {
      return refreshed;
    }

    const tickets = session.listTickets({ includeArchived: true });
    const facts = await session.listFacts();

    if (!facts.ok) {
      return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
    }

    return { ok: true, value: buildPlanTree(tickets, facts.value, effects.now()) };
  };

  const edit = async (rawId: string): Promise<Result<undefined, CliFailure>> => {
    const edited = await ticketEditor(
      { args: [], json: true, effects: loadEffects, session },
      rawId,
    );

    return edited.ok ? { ok: true, value: undefined } : edited;
  };

  // Work runs one at a time, since each refresh may sweep the archive and each read may append PR facts.
  const track = <Value>(start: () => Promise<Value>): Promise<Value> => {
    const running = previous.then(start).finally(() => {
      pending.delete(running);
    });

    previous = running.catch(() => undefined);
    pending.add(running);

    return running;
  };

  const load = () => track(read);
  const loadTree = () => track(readTree);
  const editTicket = (rawId: string) => track(() => edit(rawId));

  const close = async (): Promise<void> => {
    closing.abort();
    await Promise.allSettled(pending);
    session[Symbol.dispose]();
  };

  return { ok: true, value: { load, loadTree, edit: editTicket, close } };
};
