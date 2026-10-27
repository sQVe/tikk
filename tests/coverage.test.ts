import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture, createParentSlice } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface CoverageReport {
  gaps: { ticket: string; kind: string; criterion: string }[];
}

interface ShownTicket {
  path: string;
  hash: string;
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

const show = (id: string): Promise<ShownTicket> => cli().runJson<ShownTicket>(['show', id]);

const coverageGaps = async (plan: string): Promise<CoverageReport['gaps']> => {
  const report = await cli().runJson<CoverageReport>(['coverage', plan]);

  return report.gaps;
};

it('refuses --covers with a name the parent does not have and leaves the file unchanged', async () => {
  const plan = await createWithCriteria('plan', 'Plan', []);
  const slice = await createWithCriteria('slice', 'Slice', ['--parent', plan]);

  const instruction = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'Instruction',
    '--parent',
    slice,
    '--covers',
    'a',
  ]);

  const before = await show(instruction.id);
  const original = await Bun.file(before.path).text();

  const result = await cli().run([
    'edit',
    instruction.id,
    '--hash',
    before.hash,
    '--covers',
    'unknown',
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'invalidArguments' } });
  expect(result.stdout).toContain('unknown');
  expect(await Bun.file(before.path).text()).toBe(original);
});

it('changes the coverage gaps when --covers replaces the list, and --clear-covers restores them', async () => {
  const plan = await createWithCriteria('plan', 'Plan', []);
  const slice = await createWithCriteria('slice', 'Slice', ['--parent', plan, '--covers', 'a']);

  const instruction = await cli().runJson<{ id: string }>([
    'new',
    'instruction',
    'Instruction',
    '--parent',
    slice,
  ]);

  const gapsBefore = await coverageGaps(plan);

  const beforeCovers = await show(instruction.id);

  await cli().runChecked(['edit', instruction.id, '--hash', beforeCovers.hash, '--covers', 'a']);

  const replaced = await show(instruction.id);
  const gapsReplaced = await coverageGaps(plan);

  expect(gapsReplaced).toContainEqual({ ticket: slice, kind: 'slice', criterion: 'b' });
  expect(gapsReplaced).not.toEqual(gapsBefore);

  await cli().runChecked(['edit', instruction.id, '--hash', replaced.hash, '--clear-covers']);

  expect(await coverageGaps(plan)).toEqual(gapsBefore);
});

for (const kind of ['task', 'slice'] as const) {
  it(`refuses --covers on a ${kind} with no parent and writes nothing`, async () => {
    const id =
      kind === 'task'
        ? (await cli().runJson<{ id: string }>(['new', 'task', 'Task'])).id
        : await createWithCriteria('slice', 'Loose', []);

    const before = await show(id);
    const original = await Bun.file(before.path).text();

    const result = await cli().run(['edit', id, '--hash', before.hash, '--covers', 'a']);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { code: 'invalidArguments' } });
    expect(await Bun.file(before.path).text()).toBe(original);
  });
}
