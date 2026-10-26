import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface ShownPlan {
  id: string;
  files: string[];
}

interface Listing {
  tickets: Record<string, unknown>[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const createPlanWithFolder = async (files: string[]): Promise<string> => {
  const created = await cli().runJson<{ id: string }>([
    'new',
    'plan',
    'Design plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const folder = join(cli().storePath, 'tickets', 'demo', created.id);

  for (const file of files) {
    await mkdir(dirname(join(folder, file)), { recursive: true });
    await writeFile(join(folder, file), '# Notes\n');
  }

  return created.id;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-folder-show-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it("lists design.md and nested files in the plan's folder with show --json", async () => {
  const id = await createPlanWithFolder(['design.md', 'reports/review.md']);

  const shown = await cli().runJson<ShownPlan>(['show', id]);

  expect(shown.files).toEqual(['design.md', 'reports/review.md']);
});

it('still lists design.md when the folder also holds a dangling symlink', async () => {
  const id = await createPlanWithFolder(['design.md']);

  await symlink('missing.md', join(cli().storePath, 'tickets', 'demo', id, 'dangling.md'));

  const shown = await cli().runJson<ShownPlan>(['show', id]);

  expect(shown.files).toEqual(['dangling.md', 'design.md']);
});

it('leaves folder files out of ls --json', async () => {
  await createPlanWithFolder(['design.md']);

  const listing = await cli().runJson<Listing>(['ls']);

  expect(listing.tickets).toHaveLength(1);
  expect(listing.tickets[0]).not.toHaveProperty('files');
});
