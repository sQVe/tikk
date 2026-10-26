import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface CoverageReport {
  gaps: { ticket: string; kind: string; criterion: string }[];
}

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const createWithCriteria = async (
  kind: string,
  title: string,
  extra: string[],
): Promise<string> => {
  const file = join(cli().home, `${title}.yaml`);

  const yaml = ['a', 'b']
    .map((id) => `- id: ${id}\n  check: check ${id}\n  expected: ${id} holds`)
    .join('\n');

  await Bun.write(file, yaml);

  const created = await cli().runJson<{ id: string }>([
    'new',
    kind,
    title,
    '--criteria-file',
    file,
    ...extra,
  ]);

  return created.id;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-coverage-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

it('reports a plan criterion that no slice covers and exits 0', async () => {
  const plan = await createWithCriteria('plan', 'Plan', []);

  await createWithCriteria('slice', 'Slice', ['--parent', plan, '--covers', 'a']);

  const result = await cli().run(['coverage', plan]);

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as CoverageReport;

  expect(report.gaps).toContainEqual({ ticket: plan, kind: 'plan', criterion: 'b' });
  expect(report.gaps).not.toContainEqual({ ticket: plan, kind: 'plan', criterion: 'a' });
});

it('lists a slice criterion that no instruction covers in the --json report', async () => {
  const plan = await createWithCriteria('plan', 'Plan', []);
  const slice = await createWithCriteria('slice', 'Slice', ['--parent', plan]);

  await cli().runJson(['new', 'instruction', 'Instruction', '--parent', slice, '--covers', 'a']);

  const result = await cli().run(['coverage', plan, '--json']);

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as CoverageReport;

  expect(report.gaps).toContainEqual({ ticket: slice, kind: 'slice', criterion: 'b' });
});

it('reports the gaps of a plan and its own slices, not of other slices', async () => {
  const plan = await createWithCriteria('plan', 'Plan', []);
  const slice = await createWithCriteria('slice', 'Slice', ['--parent', plan, '--covers', 'a']);
  const other = await createWithCriteria('slice', 'Other', []);

  await cli().runJson(['new', 'instruction', 'Instruction', '--parent', slice, '--covers', 'a']);

  const report = await cli().runJson<CoverageReport>(['coverage', plan]);

  expect(report.gaps).toContainEqual({ ticket: slice, kind: 'slice', criterion: 'b' });
  expect(report.gaps).not.toContainEqual({ ticket: slice, kind: 'slice', criterion: 'a' });
  expect(report.gaps.map((gap) => gap.ticket)).not.toContain(other);
});

it('refuses an instruction ID with invalidArguments', async () => {
  const slice = await createParentSlice(cli());

  const created = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'Instruction',
    '--parent',
    slice,
  ]);

  const result = await cli().run(['coverage', created.id]);

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'invalidArguments' } });
});

it('fails with notFound for an unknown ID', async () => {
  const result = await cli().run(['coverage', 'tikk-ffff']);

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'notFound' } });
});
