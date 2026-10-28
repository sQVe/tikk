import { buildProjectTree } from '../fact/fact.ts';
import type { ProjectTree } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import type { CliEffects, CliFailure, EditorCleanupFailure } from './cliEffects.ts';
import { readNeeds } from './needsCommand.ts';
import type { NeedsReading } from './needsCommand.ts';
import { refreshSession } from './sessionRefresh.ts';
import { readTicketDetail } from './ticketDetail.ts';
import type { TicketDetail } from './ticketDetail.ts';
import { ticketEditor } from './ticketEditor.ts';
import type { EditTarget } from './ticketEditor.ts';
import { parsedTickets } from './ticketView.ts';

interface FileErrorRow {
  path: string;
  message: string;
  id: TicketId | null;
}

export interface NeedsSession {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  loadTree: () => Promise<Result<ProjectTree, CliFailure>>;
  loadErrors: () => Promise<Result<FileErrorRow[], CliFailure>>;
  loadDetail: (rawId: string) => Promise<Result<TicketDetail, CliFailure>>;
  edit: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  editDesign: (rawId: string) => Promise<Result<undefined, CliFailure>>;
  close: () => Promise<Result<undefined, EditorCleanupFailure>>;
}

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
  let cleanupFailure: EditorCleanupFailure | undefined;
  let closingResult: ReturnType<NeedsSession['close']> | undefined;

  const loadEffects: CliEffects = {
    ...effects,
    runGh: (args, signal) => effects.runGh(args, AbortSignal.any([signal, closing.signal])),
    runEditor: async (path, signal) => {
      const result = await effects.runEditor(path, AbortSignal.any([signal, closing.signal]));

      if (!result.ok && result.reason.kind === 'cleanup') {
        cleanupFailure ??= result.reason;
      }

      return result;
    },
  };

  const read = async (): Promise<Result<NeedsReading, CliFailure>> => {
    const refreshed = await refreshSession(loadEffects, session);

    if (!refreshed.ok) {
      return refreshed;
    }

    return readNeeds({ effects: loadEffects, session });
  };

  const readTree = async (): Promise<Result<ProjectTree, CliFailure>> => {
    const refreshed = await refreshSession(loadEffects, session);

    if (!refreshed.ok) {
      return refreshed;
    }

    const listed = session.listTickets({ includeArchived: true });

    if (!listed.ok) {
      return { ok: false, reason: { code: 'storeError', message: listed.reason.message } };
    }

    const facts = await session.listFacts();

    if (!facts.ok) {
      return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
    }

    const project = await effects.resolveProject();
    const current = project.ok ? project.value : null;

    const stateTickets = parsedTickets(listed.value);

    return {
      ok: true,
      value: buildProjectTree(listed.value, facts.value, effects.now(), current, stateTickets),
    };
  };

  const edit = async (
    rawId: string,
    target: EditTarget,
  ): Promise<Result<undefined, CliFailure>> => {
    const edited = await ticketEditor(
      { args: [], json: true, effects: loadEffects, session },
      rawId,
      target,
    );

    return edited.ok ? { ok: true, value: undefined } : edited;
  };

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

  const readErrors = (): Result<FileErrorRow[], CliFailure> => {
    const listed = session.listTickets({ includeArchived: true });

    if (!listed.ok) {
      return { ok: false, reason: { code: 'storeError', message: listed.reason.message } };
    }

    const errors = session.listErrors();

    if (!errors.ok) {
      return { ok: false, reason: { code: 'storeError', message: errors.reason.message } };
    }

    return {
      ok: true,
      value: errors.value.map((error) => {
        const owner = listed.value.find((ticket) => ticket.path === error.path);

        return { path: error.path, message: error.message, id: owner?.id ?? null };
      }),
    };
  };

  const loadErrors = () => track(() => Promise.resolve(readErrors()));
  const editTicket = (rawId: string) => track(() => edit(rawId, 'ticket'));
  const editDesignFile = (rawId: string) => track(() => edit(rawId, 'design'));

  const loadDetail = (rawId: string) =>
    track(() => readTicketDetail(session, effects.now(), rawId));

  const finishClose: NeedsSession['close'] = async () => {
    closing.abort();
    await Promise.allSettled(pending);
    session[Symbol.dispose]();

    return cleanupFailure === undefined
      ? { ok: true, value: undefined }
      : { ok: false, reason: cleanupFailure };
  };

  const close: NeedsSession['close'] = () => {
    closingResult ??= finishClose();

    return closingResult;
  };

  return {
    ok: true,
    value: {
      load,
      loadTree,
      loadErrors,
      loadDetail,
      edit: editTicket,
      editDesign: editDesignFile,
      close,
    },
  };
};
