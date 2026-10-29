import { z } from 'zod';

import type { Result } from '../result.ts';

export interface SyncDelays {
  debounceMilliseconds: number;
  settleMilliseconds: number;
}

export interface SyncDelayFailure {
  code: 'invalidSyncDelay';
  message: string;
}

const debounceVariable = 'TIKK_SYNC_DEBOUNCE_MILLISECONDS';
const settleVariable = 'TIKK_SYNC_SETTLE_MILLISECONDS';

export const defaultSyncDelays: SyncDelays = {
  debounceMilliseconds: 3000,
  settleMilliseconds: 2000,
};

// The debounce must cover the parent's handover of the marker to the child it starts.
const minimumDebounceMilliseconds = 1000;

const millisecondsSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int());

const parseDelay = (
  variable: string,
  text: string | undefined,
  fallback: number,
  minimum: number,
): Result<number, SyncDelayFailure> => {
  if (text === undefined) {
    return { ok: true, value: fallback };
  }

  const parsed = millisecondsSchema.safeParse(text);

  if (!parsed.success) {
    return {
      ok: false,
      reason: {
        code: 'invalidSyncDelay',
        message: `${variable} must be a whole number of milliseconds, such as ${fallback}.`,
      },
    };
  }

  if (parsed.data < minimum) {
    return {
      ok: false,
      reason: {
        code: 'invalidSyncDelay',
        message: `${variable} must be at least ${minimum} milliseconds.`,
      },
    };
  }

  return { ok: true, value: parsed.data };
};

export const parseSyncDelays = (
  environment: Record<string, string | undefined>,
): Result<SyncDelays, SyncDelayFailure> => {
  const debounce = parseDelay(
    debounceVariable,
    environment[debounceVariable],
    defaultSyncDelays.debounceMilliseconds,
    minimumDebounceMilliseconds,
  );

  if (!debounce.ok) {
    return debounce;
  }

  const settle = parseDelay(
    settleVariable,
    environment[settleVariable],
    defaultSyncDelays.settleMilliseconds,
    0,
  );

  if (!settle.ok) {
    return settle;
  }

  return {
    ok: true,
    value: { debounceMilliseconds: debounce.value, settleMilliseconds: settle.value },
  };
};

export const syncDelayEnvironment = (syncDelays: SyncDelays): Record<string, string> => ({
  [debounceVariable]: String(syncDelays.debounceMilliseconds),
  [settleVariable]: String(syncDelays.settleMilliseconds),
});
