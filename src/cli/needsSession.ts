import type { Result } from '../result.ts';
import type { CliEffects, CliFailure } from './cliEffects.ts';
import { readNeeds } from './needsCommand.ts';
import type { NeedsReading } from './needsCommand.ts';
import { refreshSession } from './sessionRefresh.ts';

export interface NeedsSession {
  load: () => Promise<Result<NeedsReading, CliFailure>>;
  // Stops running work, waits for it to settle, then releases the session.
  close: () => Promise<void>;
}

// One session stays open for the TUI's lifetime. Each load reads like `tikk needs --json` does.
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

  const loadEffects: CliEffects = {
    ...effects,
    runGh: (args, signal) => effects.runGh(args, AbortSignal.any([signal, closing.signal])),
  };

  const read = async (): Promise<Result<NeedsReading, CliFailure>> => {
    const refreshed = await refreshSession(loadEffects, session);

    if (!refreshed.ok) {
      return refreshed;
    }

    return readNeeds({ effects: loadEffects, session });
  };

  const load = (): Promise<Result<NeedsReading, CliFailure>> => {
    const running = read().finally(() => {
      pending.delete(running);
    });

    pending.add(running);

    return running;
  };

  const close = async (): Promise<void> => {
    closing.abort();
    await Promise.allSettled(pending);
    session[Symbol.dispose]();
  };

  return { ok: true, value: { load, close } };
};
