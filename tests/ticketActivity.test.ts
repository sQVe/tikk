import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openNeedsSession } from '../src/cli/cli.ts';
import type { Fact, NeedsSession } from '../src/cli/cli.ts';
import { createEffects } from '../src/index.ts';
import { invariant } from '../src/invariant.ts';
import { noDetail } from '../src/tui/detailState.ts';
import { tabBodyOf } from '../src/tui/DetailTabs.tsx';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

const machine = 'laptop';
const columns = 80;

let fixture: CliFixture | undefined;
let parentSlice = '';
let needs: NeedsSession | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const textOf = (fact: Fact): string => ('text' in fact && fact.text !== undefined ? fact.text : '');

// The two progress logs share one time, so their order comes from the order of the fact file.
const appendFacts = async (ticket: string): Promise<void> => {
  const lines = [
    {
      at: '2026-10-20T10:00:00.000Z',
      kind: 'log',
      type: 'question',
      item: '0123456789ab',
      text: 'ACTIVITY-QUESTION',
    },
    {
      at: '2026-10-20T11:00:00.000Z',
      kind: 'log',
      type: 'progress',
      text: 'ACTIVITY-FIRST-PROGRESS',
    },
    {
      at: '2026-10-20T11:00:00.000Z',
      kind: 'log',
      type: 'progress',
      text: 'ACTIVITY-SECOND-PROGRESS',
    },
    { at: '2026-10-20T12:00:00.000Z', kind: 'waiting', waiting: true, text: 'ACTIVITY-WAITING' },
  ];

  const directory = join(cli().storePath, 'facts', machine);

  await mkdir(directory, { recursive: true });

  for (const line of lines) {
    const fact = { version: 1, ticket, machine, ...line };

    await appendFile(join(directory, '2026-10.jsonl'), `${JSON.stringify(fact)}\n`);
  }
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-activity-', { machine });
  await cli().runChecked(['init']);
  parentSlice = await createParentSlice(cli());
});

afterEach(async () => {
  await needs?.close();
  needs = undefined;
  await fixture?.cleanup();
});

it('lists the same facts in the same order on the Activity tab as tikk history --json', async () => {
  const created = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'Activity instruction',
    '--parent',
    parentSlice,
  ]);

  await appendFacts(created.id);

  const history = await cli().runJson<{ facts: Fact[] }>(['history', created.id]);
  const expected = history.facts.map(textOf);

  expect(expected).toEqual([
    'ACTIVITY-WAITING',
    'ACTIVITY-FIRST-PROGRESS',
    'ACTIVITY-SECOND-PROGRESS',
    'ACTIVITY-QUESTION',
  ]);

  const opened = await openNeedsSession(
    createEffects(cli().storePath, join(cli().home, 'index.db')),
  );

  invariant(opened.ok, 'The needs session should open.');
  needs = opened.value;

  // The TUI loads the home list before it loads a detail, and that load refreshes the store.
  const reading = await needs.load();

  invariant(reading.ok, 'The needs list should load.');

  const loaded = await needs.loadDetail(created.id);

  invariant(loaded.ok, 'The detail should load.');

  const body = tabBodyOf(
    {
      ...noDetail,
      id: created.id,
      load: { status: 'loaded', detail: loaded.value },
      tab: 'activity',
    },
    columns,
  );

  const listed = body.map((line) => line.trim()).filter((line) => expected.includes(line));

  expect(listed).toEqual(expected);
});
