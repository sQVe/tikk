import { expect, it } from 'bun:test';

import type { CacheFiles, TicketCache } from './cache/cache.ts';
import { listFactsRecovering } from './sessionEffects.ts';

const fakeCacheCountingRebuilds = () => {
  const rebuilds = { count: 0 };

  const cache: Pick<TicketCache, 'rebuildFacts'> = {
    rebuildFacts: () => {
      rebuilds.count += 1;

      return Promise.resolve({ ok: true, value: undefined });
    },
  };

  return { cache, rebuilds };
};

const unusedFiles = {} as CacheFiles;

it('does not rebuild the fact tables when a read fails because the cache is busy', async () => {
  const { cache, rebuilds } = fakeCacheCountingRebuilds();

  const listed = await listFactsRecovering(cache, unusedFiles, () => ({
    ok: false,
    reason: { kind: 'failed', message: 'database is locked' },
  }));

  expect(listed).toMatchObject({ ok: false, reason: { message: 'database is locked' } });
  expect(rebuilds.count).toBe(0);
});

it('rebuilds the fact tables once when a read finds damage, then reads them again', async () => {
  const { cache, rebuilds } = fakeCacheCountingRebuilds();
  let reads = 0;

  const listed = await listFactsRecovering(cache, unusedFiles, () => {
    reads += 1;

    return reads === 1
      ? { ok: false, reason: { kind: 'damaged', message: 'Bad fact.' } }
      : { ok: true, value: [] };
  });

  expect(listed).toEqual({ ok: true, value: [] });
  expect(rebuilds.count).toBe(1);
});
