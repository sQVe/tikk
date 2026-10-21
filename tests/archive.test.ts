import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface Listing {
  tickets: { id: string; archived: string | null }[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const listedIds = async (args: string[]): Promise<string[]> => {
  const listing = await cli().runJson<Listing>(args);

  return listing.tickets.map((ticket) => ticket.id);
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-archive-');
  await fixture.runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

// Writes a canceled plan and a status fact that dates its cancel 15 days ago.
const writeCanceledPlan = async (): Promise<string> => {
  const planPath = join(cli().storePath, 'tickets', 'demo', 'demo-3467-old-plan.md');
  const canceledAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const factFolder = join(cli().storePath, 'facts', 'laptop');

  const factLine = JSON.stringify({
    version: 1,
    kind: 'status',
    ticket: 'demo-3467',
    at: canceledAt,
    machine: 'laptop',
    status: 'canceled',
  });

  await mkdir(join(cli().storePath, 'tickets', 'demo'), { recursive: true });
  await mkdir(factFolder, { recursive: true });

  await writeFile(
    planPath,
    '---\nkind: plan\ntitle: Old plan\nproject: demo\nstatus: canceled\n---\nA body\n',
  );

  await writeFile(join(factFolder, `${canceledAt.slice(0, 7)}.jsonl`), `${factLine}\n`);

  return planPath;
};

it('archives a plan canceled 15 days ago in place on the next command', async () => {
  const planPath = await writeCanceledPlan();

  const listed = await listedIds(['ls']);
  const planText = await readFile(planPath, 'utf8');

  expect(planText).toMatch(/^archived: \d{4}-\d{2}-\d{2}$/m);
  expect(listed).toEqual([]);
  expect(await listedIds(['ls', '--archived'])).toEqual(['demo-3467']);
});

it('answers ls at once and leaves the plan when a live process holds the store lock', async () => {
  const planPath = await writeCanceledPlan();
  const lockPath = join(cli().storePath, '.git', 'tikk.lock');

  await writeFile(lockPath, `${process.pid}\n`);

  const start = performance.now();
  const listed = await listedIds(['ls']);
  const elapsed = performance.now() - start;

  await rm(lockPath);

  expect(elapsed).toBeLessThan(2000);
  expect(listed).toEqual(['demo-3467']);
  expect(await readFile(planPath, 'utf8')).not.toContain('archived:');
});
