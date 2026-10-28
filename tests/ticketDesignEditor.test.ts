import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { writeEditorScript } from './tuiTerminalFixture.ts';

interface CreatedTicket {
  id: string;
  project: string;
}

interface CliFailureBody {
  error: { code: string; message: string };
}

let fixture: CliFixture | undefined;
let recordPath = '';

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const folderOf = (ticket: CreatedTicket): string =>
  join(cli().storePath, 'tickets', ticket.project, ticket.id);

const recordedEditorPaths = async (): Promise<string[]> =>
  existsSync(recordPath)
    ? (await readFile(recordPath, 'utf8')).split('\n').filter((line) => line !== '')
    : [];

beforeEach(async () => {
  fixture = await createCliFixture('tikk-ticket-design-editor-');
  await cli().runChecked(['init']);

  recordPath = join(cli().home, 'editor-arguments.txt');

  const editorPath = await writeEditorScript(
    cli().home,
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${recordPath}'\n`,
  );

  Bun.env['EDITOR'] = editorPath;
});

afterEach(async () => {
  delete Bun.env['EDITOR'];
  await fixture?.cleanup();
});

it('opens the design.md of a plan in $EDITOR with tikk edit --design', async () => {
  const plan = await cli().runJson<CreatedTicket>(['new', 'plan', 'aaaa', '--status', 'draft']);
  const folder = folderOf(plan);

  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'design.md'), '# Design\n');

  await cli().runChecked(['edit', plan.id, '--design']);

  expect(await recordedEditorPaths()).toEqual([join(folder, 'design.md')]);
});

it('fails with invalidArguments for a slice and does not open an editor', async () => {
  const slice = await cli().runJson<CreatedTicket>(['new', 'slice', 'bbbb', '--status', 'draft']);

  const result = await cli().run(['edit', slice.id, '--design']);
  const body = JSON.parse(result.stdout) as CliFailureBody;

  expect(result.exitCode).not.toBe(0);
  expect(body.error.code).toBe('invalidArguments');
  expect(body.error.message).toContain(slice.id);
  expect(await recordedEditorPaths()).toEqual([]);
});

it('fails with notFound that names the path when design.md is missing, and creates no file', async () => {
  const plan = await cli().runJson<CreatedTicket>(['new', 'plan', 'cccc', '--status', 'draft']);
  const designPath = join(folderOf(plan), 'design.md');

  const result = await cli().run(['edit', plan.id, '--design']);
  const body = JSON.parse(result.stdout) as CliFailureBody;

  expect(result.exitCode).not.toBe(0);
  expect(body.error.code).toBe('notFound');
  expect(body.error.message).toContain(designPath);
  expect(existsSync(designPath)).toBe(false);
  expect(await recordedEditorPaths()).toEqual([]);
});

it('rejects a field flag with --design and does not open an editor', async () => {
  const plan = await cli().runJson<CreatedTicket>(['new', 'plan', 'dddd', '--status', 'draft']);

  const result = await cli().run(['edit', plan.id, '--design', '--title', 'Other']);
  const body = JSON.parse(result.stdout) as CliFailureBody;

  expect(result.exitCode).not.toBe(0);
  expect(body.error.code).toBe('invalidArguments');
  expect(await recordedEditorPaths()).toEqual([]);
});
