import { afterEach, expect, it } from 'bun:test';

import type { NeedView, ProjectTree, TreeProject, TreeSlice } from '../cli/cli.ts';
import { createTuiFixture, needView, projectName, ticketId } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

let fixture: TuiFixture | undefined;

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const size = { width: 70, height: 16 };

const sliceOf = (number: number, instructions: TreeSlice['instructions'] = []): TreeSlice => ({
  id: ticketId(`demo-${number}`),
  title: `Slice ${number}`,
  state: 'active',
  pr: null,
  tasks: [],
  instructions,
});

const projectOf = (name: string, planNumber: number, slices: TreeSlice[]): TreeProject => ({
  name: projectName(name),
  inbox: [],
  plans: [
    {
      id: ticketId(`demo-${planNumber}`),
      title: `Plan ${planNumber}`,
      state: 'open',
      tasks: [],
      slices,
    },
  ],
  slices: [],
});

const instructionOf = (number: number): TreeSlice['instructions'][number] => ({
  id: ticketId(`demo-${number}`),
  title: `Instruction ${number}`,
  state: 'open',
});

const twoProjects = (): ProjectTree => ({
  current: projectName('beta'),
  projects: [
    projectOf('beta', 3500, [sliceOf(3501)]),
    projectOf('alpha', 3510, [sliceOf(3511, [instructionOf(3512), instructionOf(3513)])]),
  ],
});

const linesOf = (fixtureOf: TuiFixture): string[] =>
  fixtureOf.setup
    .captureCharFrame()
    .split('\n')
    .filter((line) => line.trim() !== '');

const indexOfLine = (lines: readonly string[], text: string): number =>
  lines.findIndex((line) => line.includes(text));

it('shows the current project first and unfolded, and the other projects folded', async () => {
  const mounted = await mount([], size, [], twoProjects());

  await mounted.press('s');

  const lines = linesOf(mounted);
  const beta = indexOfLine(lines, 'beta');
  const alpha = indexOfLine(lines, 'alpha');

  expect(beta).toBeGreaterThan(-1);
  expect(alpha).toBeGreaterThan(beta);
  expect(indexOfLine(lines, 'demo-3500  Plan 3500')).toBeGreaterThan(beta);
  expect(indexOfLine(lines, 'demo-3501  Slice 3501')).toBeLessThan(alpha);
  expect(mounted.setup.captureCharFrame()).not.toContain('Plan 3510');
  expect(mounted.selectedLine()).toContain('beta');
});

it('folds every project when no project is current', async () => {
  const mounted = await mount([], size, [], { ...twoProjects(), current: null });

  await mounted.press('s');

  const frame = mounted.setup.captureCharFrame();

  expect(frame).toContain('beta');
  expect(frame).toContain('alpha');
  expect(frame).not.toContain('Plan 3500');
  expect(frame).not.toContain('Plan 3510');
});

it('shows a loose task under its project Inbox row', async () => {
  const tree = twoProjects();
  const [beta] = tree.projects;

  beta?.inbox.push({ id: ticketId('demo-3520'), title: 'Loose task', kind: 'task', state: 'open' });

  const mounted = await mount([], size, [], tree);

  await mounted.press('s');

  const lines = linesOf(mounted);
  const inbox = indexOfLine(lines, 'Inbox (1)');

  expect(inbox).toBeGreaterThan(indexOfLine(lines, 'beta'));
  expect(lines[inbox + 1]).toContain('demo-3520  Loose task');
  expect(lines[inbox + 2]).toContain('demo-3500  Plan 3500');
});

it('shows an Inbox instruction with the instruction icon and its derived state', async () => {
  const tree = twoProjects();
  const [beta] = tree.projects;

  beta?.inbox.push({
    id: ticketId('demo-3530'),
    title: 'Orphan instruction',
    kind: 'instruction',
    state: 'done',
  });

  const mounted = await mount([], size, [], tree);

  await mounted.press('s');

  const lines = linesOf(mounted);
  const inbox = indexOfLine(lines, 'Inbox (1)');

  expect(lines[inbox + 1]).toContain('› ● demo-3530  Orphan instruction');
});

it('unfolds a folded project with za and lists the instructions of a slice under Instructions (n)', async () => {
  const mounted = await mount([], size, [], twoProjects());

  await mounted.press('s');
  await mounted.press('G');
  expect(mounted.selectedLine()).toContain('alpha');

  await mounted.press('z');
  await mounted.press('a');
  expect(mounted.setup.captureCharFrame()).toContain('demo-3511  Slice 3511');
  expect(mounted.setup.captureCharFrame()).not.toContain('Instruction 3512');

  await mounted.press('G');
  expect(mounted.selectedLine()).toContain('Instructions (2)');

  await mounted.press('z');
  await mounted.press('a');

  const lines = linesOf(mounted);
  const heading = indexOfLine(lines, 'Instructions (2)');

  expect(lines[heading + 1]).toContain('demo-3512  Instruction 3512');
  expect(lines[heading + 2]).toContain('demo-3513  Instruction 3513');
  expect(mounted.selectedLine()).toContain('Instructions (2)');
});

it('folds with zc and space, opens with zo, and keeps folds across a reload', async () => {
  const mounted = await mount([], size, [], twoProjects());

  await mounted.press('s');
  await mounted.press('z');
  await mounted.press('c');
  expect(mounted.setup.captureCharFrame()).not.toContain('Plan 3500');
  expect(mounted.selectedLine()).toContain('beta');

  await mounted.press('z');
  await mounted.press('o');
  expect(mounted.setup.captureCharFrame()).toContain('Plan 3500');

  await mounted.press(' ');
  expect(mounted.setup.captureCharFrame()).not.toContain('Plan 3500');

  await mounted.storeChanged();
  expect(mounted.setup.captureCharFrame()).not.toContain('Plan 3500');
  expect(mounted.selectedLine()).toContain('beta');
});

it('counts the open needs of a slice instructions on its Instructions row', async () => {
  const tree = twoProjects();
  const [beta] = tree.projects;
  const slice = beta?.plans[0]?.slices[0];

  slice?.instructions.push(instructionOf(3502), instructionOf(3503));

  const question: NeedView = { ...needView(0, 'Question'), id: ticketId('demo-3502') };
  const submitted: NeedView = { ...needView(1, 'Submitted'), id: ticketId('demo-3502') };
  const elsewhere: NeedView = { ...needView(2, 'Elsewhere'), id: ticketId('demo-3512') };
  const mounted = await mount([question, submitted, elsewhere], size, [], tree);

  await mounted.press('s');

  const row = linesOf(mounted).find((line) => line.includes('Instructions (2)'));

  expect(row).toMatch(/Instructions \(2\)\s+! 2/);
});

it('shows a state icon on a ticket row and none on a project row, and never prints undefined', async () => {
  const mounted = await mount([], size, [], twoProjects());

  await mounted.press('s');

  const lines = linesOf(mounted);

  expect(lines[indexOfLine(lines, 'demo-3500  Plan 3500')]).toContain('◆ ○ demo-3500  Plan 3500');
  expect(lines[indexOfLine(lines, 'beta')]).toContain('■ beta');
  expect(lines.join('\n')).not.toContain('undefined');
});
