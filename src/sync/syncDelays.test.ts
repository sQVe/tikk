import { expect, it } from 'bun:test';

import { parseSyncDelays } from './syncDelays.ts';

it('uses 3000 and 2000 milliseconds when the variables are unset', () => {
  expect(parseSyncDelays({})).toEqual({
    ok: true,
    value: { debounceMilliseconds: 3000, settleMilliseconds: 2000 },
  });
});

it('takes whole-number values of both variables', () => {
  expect(
    parseSyncDelays({
      TIKK_SYNC_DEBOUNCE_MILLISECONDS: '1500',
      TIKK_SYNC_SETTLE_MILLISECONDS: '0',
    }),
  ).toEqual({
    ok: true,
    value: { debounceMilliseconds: 1500, settleMilliseconds: 0 },
  });
});

it('rejects a value that is not a whole number of milliseconds and names the variable', () => {
  for (const text of ['', 'soon', '-1', '1.5', '1e3', ' 5']) {
    const parsed = parseSyncDelays({ TIKK_SYNC_SETTLE_MILLISECONDS: text });

    expect(parsed).toEqual({
      ok: false,
      reason: {
        code: 'invalidSyncDelay',
        message:
          'TIKK_SYNC_SETTLE_MILLISECONDS must be a whole number of milliseconds, such as 2000.',
      },
    });
  }
});

it('rejects a debounce below 1000 milliseconds and names the minimum', () => {
  for (const text of ['0', '999']) {
    const parsed = parseSyncDelays({ TIKK_SYNC_DEBOUNCE_MILLISECONDS: text });

    expect(parsed).toEqual({
      ok: false,
      reason: {
        code: 'invalidSyncDelay',
        message: 'TIKK_SYNC_DEBOUNCE_MILLISECONDS must be at least 1000 milliseconds.',
      },
    });
  }
});

it('accepts a debounce of exactly 1000 milliseconds', () => {
  expect(parseSyncDelays({ TIKK_SYNC_DEBOUNCE_MILLISECONDS: '1000' })).toEqual({
    ok: true,
    value: { debounceMilliseconds: 1000, settleMilliseconds: 2000 },
  });
});

it('rejects an invalid debounce even when the settle value is valid', () => {
  const parsed = parseSyncDelays({
    TIKK_SYNC_DEBOUNCE_MILLISECONDS: 'later',
    TIKK_SYNC_SETTLE_MILLISECONDS: '0',
  });

  expect(parsed.ok).toBe(false);
  expect(parsed.ok ? '' : parsed.reason.message).toContain('TIKK_SYNC_DEBOUNCE_MILLISECONDS');
});
