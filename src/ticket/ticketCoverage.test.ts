import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseProjectName, parseTicketId } from './ticket.ts';
import type { TicketFrontMatter, TicketId } from './ticket.ts';
import { findCoverageGaps } from './ticketCoverage.ts';

const idOf = (raw: string): TicketId => {
  const parsed = parseTicketId(raw);

  invariant(parsed.ok, `Test ID ${raw} is invalid.`);

  return parsed.value;
};

const project = parseProjectName('tikk');

invariant(project.ok, 'The test project must be valid.');

const slicePlan = idOf('tikk-3a4b');
const slice = idOf('tikk-3a4c');
const instruction = idOf('tikk-3a4d');

const criteria = ['a', 'b'].map((id) => ({ id, check: `check ${id}`, expected: `${id} holds` }));

const ticket = (
  id: TicketId,
  fields: Partial<TicketFrontMatter>,
): { id: TicketId; frontMatter: TicketFrontMatter } => ({
  id,
  frontMatter: {
    kind: 'instruction',
    title: 'T',
    project: project.value,
    blockedBy: [],
    discoveredFrom: [],
    related: [],
    status: 'open',
    ...fields,
  },
});

const plan = ticket(slicePlan, { kind: 'plan', criteria });

const sliceFor = (fields: Partial<TicketFrontMatter>) =>
  ticket(slice, { kind: 'slice', parent: slicePlan, criteria, covers: ['a', 'b'], ...fields });

const instructionFor = (fields: Partial<TicketFrontMatter>) =>
  ticket(instruction, { kind: 'instruction', parent: slice, ...fields });

it('lets an instruction with no covers cover every criterion of its slice', () => {
  const gaps = findCoverageGaps([plan, sliceFor({}), instructionFor({})]);

  expect(gaps).toEqual([]);
});

it('leaves the criteria an instruction does not name as gaps', () => {
  const gaps = findCoverageGaps([plan, sliceFor({}), instructionFor({ covers: ['a'] })]);

  expect(gaps).toEqual([{ ticket: slice, kind: 'slice', criterion: 'b' }]);
});

it('treats a slice with no covers as covering no plan criterion', () => {
  const gaps = findCoverageGaps([plan, sliceFor({ covers: undefined })]);

  expect(gaps.filter((gap) => gap.ticket === slicePlan).map((gap) => gap.criterion)).toEqual([
    'a',
    'b',
  ]);
});

it('counts nothing from a canceled slice or instruction', () => {
  const canceledSlice = findCoverageGaps([plan, sliceFor({ status: 'canceled' })]);

  const canceledInstruction = findCoverageGaps([
    plan,
    sliceFor({}),
    instructionFor({ status: 'canceled' }),
  ]);

  expect(canceledSlice.map((gap) => gap.ticket)).toEqual([slicePlan, slicePlan]);

  expect(canceledInstruction).toEqual([
    { ticket: slice, kind: 'slice', criterion: 'a' },
    { ticket: slice, kind: 'slice', criterion: 'b' },
  ]);
});

it('reports no gaps of its own for a canceled plan', () => {
  const gaps = findCoverageGaps([
    { ...plan, frontMatter: { ...plan.frontMatter, status: 'canceled' } },
  ]);

  expect(gaps).toEqual([]);
});

it('ignores a covers ID that names no criterion', () => {
  const gaps = findCoverageGaps([plan, sliceFor({ covers: ['a', 'zzz'] })]);

  expect(gaps.filter((gap) => gap.kind === 'plan')).toEqual([
    { ticket: slicePlan, kind: 'plan', criterion: 'b' },
  ]);
});

it('counts only slices for a plan and only instructions for a slice', () => {
  const instructionUnderPlan = ticket(instruction, { kind: 'instruction', parent: slicePlan });
  const taskUnderSlice = ticket(idOf('tikk-3a4e'), { kind: 'task', parent: slice });

  const gaps = findCoverageGaps([
    plan,
    sliceFor({ covers: undefined }),
    instructionUnderPlan,
    taskUnderSlice,
  ]);

  expect(gaps).toEqual([
    { ticket: slicePlan, kind: 'plan', criterion: 'a' },
    { ticket: slicePlan, kind: 'plan', criterion: 'b' },
    { ticket: slice, kind: 'slice', criterion: 'a' },
    { ticket: slice, kind: 'slice', criterion: 'b' },
  ]);
});
