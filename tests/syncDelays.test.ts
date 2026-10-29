import { afterEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cliEnvironment,
  createCliFixture,
  createCloneFixtures,
  createParentSlice,
  waitForBackgroundSync,
} from './cliFixture.ts';
import type { CliFixture, CloneFixtures } from './cliFixture.ts';

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

let fixture: CliFixture | undefined;
let clones: CloneFixtures | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  await clones?.cleanup();
  fixture = undefined;
  clones = undefined;
});

it('rejects a sync delay that is not a whole number and touches no store', async () => {
  fixture = await createCliFixture('tikk-sync-delays-');

  const child = Bun.spawn(['bun', 'run', entryPath, 'init', '--json'], {
    cwd: fixture.home,
    env: {
      ...cliEnvironment(fixture.home, fixture.storePath),
      TIKK_SYNC_SETTLE_MILLISECONDS: 'soon',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  expect(exitCode).toBe(1);

  expect(JSON.parse(stdout)).toEqual({
    error: {
      code: 'invalidSyncDelay',
      message:
        'TIKK_SYNC_SETTLE_MILLISECONDS must be a whole number of milliseconds, such as 2000.',
    },
  });

  expect(existsSync(fixture.storePath)).toBe(false);
});

it('a settle delay of 0 commits a ticket file as soon as it is written', async () => {
  clones = await createCloneFixtures('tikk-sync-delays-', {
    debounceMilliseconds: 1000,
    settleMilliseconds: 0,
  });

  const { first, remotePath } = clones;

  await first.runChecked(['init', '--remote', remotePath]);

  const directory = join(first.storePath, 'tickets', 'demo');

  await mkdir(directory, { recursive: true });

  await writeFile(
    join(directory, 'demo-aaaa-a.md'),
    '---\nkind: instruction\ntitle: By hand\nproject: demo\nblockedBy: []\nstatus: open\n---\n',
  );

  const report = await first.runJson<{ committed: boolean; pending: string[] }>(['sync']);

  expect(report.committed).toBe(true);
  expect(report.pending).toEqual([]);
});

it('the background sync that a write starts waits for the debounce the CLI was started with', async () => {
  clones = await createCloneFixtures('tikk-sync-delays-', {
    debounceMilliseconds: 4000,
    settleMilliseconds: 1000,
  });

  const { first, remotePath } = clones;

  await first.runChecked(['init', '--remote', remotePath]);

  const started = Date.now();
  const parentSlice = await createParentSlice(first);

  await first.runChecked(['new', 'instruction', 'Delayed', '--parent', parentSlice]);
  await waitForBackgroundSync(first.storePath);

  expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
}, 30_000);
