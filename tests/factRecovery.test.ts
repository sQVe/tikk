import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface ShownTask {
  id: string;
  state: string;
  claim: { holder: string } | null;
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const runSql = (sql: string): void => {
  const database = new Database(join(cli().home, '.cache', 'tikk', 'index.db'));

  database.run(sql);
  database.close();
};

// A claim that was indexed, then loses its holder in the cache. The fact file stays whole.
const claimedTask = async (): Promise<ShownTask> => {
  const created = await cli().runJson<ShownTask>(['new', 'task', 'Damaged cache']);

  await cli().runJson(['claim', created.id, '--holder', 'agent']);
  await cli().runJson(['show', created.id]);
  runSql("UPDATE facts SET json = json_remove(json, '$.holder') WHERE kind = 'claim'");

  return created;
};

const submittedTask = async (): Promise<ShownTask> => {
  const created = await cli().runJson<ShownTask>(['new', 'task', 'Submitted']);

  await cli().runJson(['claim', created.id, '--holder', 'agent']);
  await cli().runJson(['submit', created.id, '--holder', 'agent']);
  await cli().runJson(['show', created.id]);

  return created;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-recovery-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('reads the facts again from the files when a stored claim has lost its holder', async () => {
  const task = await claimedTask();
  const shown = await cli().runJson<ShownTask>(['show', task.id]);
  const ready = await cli().runJson<{ skipped: { id: string; holder: string }[] }>(['ready']);

  expect(shown.state).toBe('active');
  expect(shown.claim?.holder).toBe('agent');
  expect(ready.skipped).toMatchObject([{ id: task.id, holder: 'agent' }]);
});

it('reports a store error when the rebuilt facts do not decode either', async () => {
  const task = await claimedTask();

  runSql(
    `CREATE TRIGGER damage AFTER INSERT ON facts WHEN NEW.kind = 'claim'
    BEGIN UPDATE facts SET json = json_remove(json, '$.holder') WHERE rowid = NEW.rowid; END`,
  );

  const shown = await cli().run(['show', task.id]);

  expect(shown.exitCode).toBe(1);
  expect(JSON.parse(shown.stdout)).toMatchObject({ error: { code: 'storeError' } });
});

it('rebuilds when a selected claim row holds malformed JSON', async () => {
  const task = await claimedTask();

  runSql("UPDATE facts SET json = 'not json' WHERE kind = 'claim'");

  const shown = await cli().runJson<ShownTask>(['show', task.id]);

  expect(shown.state).toBe('active');
});

it('rebuilds when a submitted log row lost its type, and keeps the task submitted', async () => {
  const task = await submittedTask();

  runSql(
    "UPDATE facts SET json = json_remove(json, '$.type') WHERE kind = 'log' AND log_type = 'submitted'",
  );

  const shown = await cli().runJson<ShownTask>(['show', task.id]);
  const claimed = await cli().run(['claim', task.id, '--holder', 'other']);

  expect(shown.state).toBe('submitted');
  expect(claimed.exitCode).toBe(1);
});
