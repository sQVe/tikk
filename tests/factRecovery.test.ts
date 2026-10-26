import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface ShownInstruction {
  id: string;
  state: string;
  claim: { holder: string } | null;
}

let fixture: CliFixture | undefined;
let parentSlice = '';

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
const claimedInstruction = async (): Promise<ShownInstruction> => {
  const created = await cli().runJson<ShownInstruction>([
    'new',
    'instruction',
    'Damaged cache',
    '--parent',
    parentSlice,
  ]);

  await cli().runJson(['claim', created.id, '--holder', 'agent']);
  await cli().runJson(['show', created.id]);
  runSql("UPDATE facts SET json = json_remove(json, '$.holder') WHERE kind = 'claim'");

  return created;
};

const submittedInstruction = async (): Promise<ShownInstruction> => {
  const created = await cli().runJson<ShownInstruction>([
    'new',
    'instruction',
    'Submitted',
    '--parent',
    parentSlice,
  ]);

  await cli().runJson(['claim', created.id, '--holder', 'agent']);
  await cli().runJson(['submit', created.id, '--holder', 'agent']);
  await cli().runJson(['show', created.id]);

  return created;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-recovery-');
  await cli().runChecked(['init']);
  parentSlice = await createParentSlice(cli());
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('reads the facts again from the files when a stored claim has lost its holder', async () => {
  const instruction = await claimedInstruction();
  const shown = await cli().runJson<ShownInstruction>(['show', instruction.id]);
  const ready = await cli().runJson<{ skipped: { id: string; holder: string }[] }>(['ready']);

  expect(shown.state).toBe('active');
  expect(shown.claim?.holder).toBe('agent');
  expect(ready.skipped).toMatchObject([{ id: instruction.id, holder: 'agent' }]);
});

it('reports a store error when the rebuilt facts do not decode either', async () => {
  const instruction = await claimedInstruction();

  runSql(
    `CREATE TRIGGER damage AFTER INSERT ON facts WHEN NEW.kind = 'claim'
    BEGIN UPDATE facts SET json = json_remove(json, '$.holder') WHERE rowid = NEW.rowid; END`,
  );

  const shown = await cli().run(['show', instruction.id]);

  expect(shown.exitCode).toBe(1);
  expect(JSON.parse(shown.stdout)).toMatchObject({ error: { code: 'storeError' } });
});

it('rebuilds when a selected claim row holds malformed JSON', async () => {
  const instruction = await claimedInstruction();

  runSql("UPDATE facts SET json = 'not json' WHERE kind = 'claim'");

  const shown = await cli().runJson<ShownInstruction>(['show', instruction.id]);

  expect(shown.state).toBe('active');
});

it('rebuilds when a submitted log row lost its type, and keeps the instruction submitted', async () => {
  const instruction = await submittedInstruction();

  runSql(
    "UPDATE facts SET json = json_remove(json, '$.type') WHERE kind = 'log' AND log_type = 'submitted'",
  );

  const shown = await cli().runJson<ShownInstruction>(['show', instruction.id]);
  const claimed = await cli().run(['claim', instruction.id, '--holder', 'other']);

  expect(shown.state).toBe('submitted');
  expect(claimed.exitCode).toBe(1);
});
