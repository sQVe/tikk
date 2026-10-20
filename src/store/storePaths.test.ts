import { expect, it } from 'bun:test';
import { join, resolve } from 'node:path';

import { resolveStoreRoot } from './storePaths.ts';

it('uses TIKK_HOME as an absolute path when it is set', () => {
  expect(resolveStoreRoot({ tikkHome: 'relative/store', homeDirectory: '/home/me' })).toBe(
    resolve('relative/store'),
  );
});

it.each([undefined, ''])('falls back to the home folder when TIKK_HOME is %j', (tikkHome) => {
  expect(resolveStoreRoot({ tikkHome, homeDirectory: '/home/me' })).toBe(
    join('/home/me', '.local', 'share', 'tikk'),
  );
});
