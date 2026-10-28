import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createDatabaseFixture,
  createFakeFiles,
  openTestCache,
  ticketText,
} from '../src/cache/cacheHarness.ts';
import { runCli } from '../src/cli/cli.ts';
import { makeEffects, makeSession } from '../src/cli/cliHarness.ts';

it('reports storeError as JSON when the cache stays busy during a query', async () => {
  const { databasePath, cleanup } = await createDatabaseFixture();
  const files = createFakeFiles();

  files.set(join('/store', 'demo', 'demo-3467-title.md'), ticketText({ title: 'One' }));

  try {
    using cache = openTestCache(databasePath, 10);

    const inode = (await stat(databasePath)).ino;
    const holder = new Database(databasePath);

    const fakeSession = makeSession({
      overrides: {
        refresh: () => cache.refresh(files.files),
        getTicket: (id) => {
          holder.run('BEGIN EXCLUSIVE');

          return cache.getTicket(id);
        },
      },
    });

    const { effects } = makeEffects({ session: fakeSession });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['show', 'demo-3467', '--json'], effects, {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }).finally(() => {
      holder.close();
    });

    const error = (JSON.parse(stdout.join('')) as { error: { code: string } }).error;

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(error.code).toBe('storeError');
    expect((await stat(databasePath)).ino).toBe(inode);
  } finally {
    await cleanup();
  }
});
