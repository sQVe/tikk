import { afterEach, expect, it } from 'bun:test';

import type { NeedView, TicketDetail } from '../cli/cli.ts';
import { createTuiFixture, needView, projectTree, ticketDetail, ticketId } from './tuiHarness.tsx';
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

const questionOf = (text: string): NeedView => ({
  ...needView(0, 'Instruction title'),
  reason: 'question',
  item: 'q1',
  passedUp: true,
  text,
});

const loadDetailOf =
  (details: readonly TicketDetail[]) =>
  (rawId: string): Promise<{ ok: true; value: TicketDetail }> => {
    const detail = details.find((candidate) => candidate.ticket.id === rawId);

    if (detail === undefined) {
      throw new Error(`The test has no detail for ${rawId}.`);
    }

    return Promise.resolve({ ok: true, value: detail });
  };

const instructionDetail = (body: string): TicketDetail =>
  ticketDetail(
    'demo-3400',
    { kind: 'instruction', title: 'Instruction title', state: 'open', parent: 'demo-3402' },
    { body },
  );

const linesOf = (mounted: TuiFixture): string[] => mounted.setup.captureCharFrame().split('\n');

const tabBarIndex = (lines: readonly string[]): number =>
  lines.findIndex((line) => line.includes('Overview'));

const rowIndex = (lines: readonly string[], text: string): number =>
  lines.findIndex((line) => line.includes(text));

it('shows a passed-up question above the tabs on every tab of an instruction', async () => {
  const detail = instructionDetail('## Outcome\n\nOUTCOME-MARKER\n\n## Notes\n\nNOTES-MARKER\n');

  const mounted = await mount(
    [questionOf('QUESTION-MARKER?')],
    { width: 80, height: 24 },
    [],
    undefined,
    {
      loadDetail: loadDetailOf([detail]),
    },
  );

  await mounted.press('RETURN');

  const overview = linesOf(mounted);

  expect(rowIndex(overview, 'QUESTION-MARKER')).toBeGreaterThan(-1);
  expect(rowIndex(overview, 'QUESTION-MARKER')).toBeLessThan(tabBarIndex(overview));
  expect(overview[tabBarIndex(overview)]).not.toContain('Criteria');
  expect(overview.join('\n')).toContain('OUTCOME-MARKER');
  expect(overview.join('\n')).not.toContain('NOTES-MARKER');

  await mounted.press(']');

  const activity = linesOf(mounted);

  expect(rowIndex(activity, 'QUESTION-MARKER')).toBeGreaterThan(-1);
  expect(rowIndex(activity, 'QUESTION-MARKER')).toBeLessThan(tabBarIndex(activity));
  expect(activity.join('\n')).not.toContain('OUTCOME-MARKER');
  expect(activity.join('\n')).not.toMatch(/Parent\s+demo-3402/);

  await mounted.press(']');

  const links = linesOf(mounted);

  expect(rowIndex(links, 'QUESTION-MARKER')).toBeGreaterThan(-1);
  expect(rowIndex(links, 'QUESTION-MARKER')).toBeLessThan(tabBarIndex(links));
  expect(links.join('\n')).toMatch(/Parent\s+demo-3402/);

  await mounted.press(']');

  expect(linesOf(mounted).join('\n')).toContain('OUTCOME-MARKER');
});

const bodyRowsOf = (lines: readonly string[]): number =>
  lines.filter((line) => line.includes('BODY-')).length;

it('cuts a ten-line question to four lines and expands it with x down to ten body rows at 80 by 24', async () => {
  const question = Array.from({ length: 10 }, (_, index) => `QUESTION-LINE-${index + 1}`).join(
    '\n',
  );

  const body = Array.from({ length: 40 }, (_, index) => `BODY-${index + 1}`).join('\n');

  const detail = ticketDetail(
    'demo-3400',
    { kind: 'task', title: 'Task title', state: 'open', parent: 'demo-3401' },
    { body },
  );

  const mounted = await mount([questionOf(question)], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([detail]),
  });

  await mounted.press('RETURN');

  const collapsed = linesOf(mounted);
  const headerEnd = rowIndex(collapsed, 'demo › demo-3401');

  expect(headerEnd).toBeGreaterThan(-1);
  expect(tabBarIndex(collapsed) - headerEnd - 1).toBe(4);
  expect(collapsed.join('\n')).toContain('QUESTION-LINE-1');
  expect(collapsed.join('\n')).not.toContain('QUESTION-LINE-10');
  // The reason line and the first two question lines show, so the cut hides eight lines.
  expect(collapsed.join('\n')).toMatch(/\+8 more/);
  expect(bodyRowsOf(collapsed)).toBeGreaterThanOrEqual(10);

  await mounted.press('x');

  const expanded = linesOf(mounted);

  expect(tabBarIndex(expanded) - headerEnd - 1).toBeGreaterThan(4);
  expect(bodyRowsOf(expanded)).toBe(10);

  await mounted.press('x');

  expect(tabBarIndex(linesOf(mounted)) - headerEnd - 1).toBe(4);
});

const criterion = (id: string) => ({ id, check: `Check ${id}`, expected: `Expected ${id}` });

it('shows the Criteria tab with its count for a slice and leaves it out for an instruction', async () => {
  const slice = ticketDetail(
    'demo-3402',
    { kind: 'slice', title: 'Slice title', state: 'active', parent: 'demo-3401' },
    { ticket: { criteria: [criterion('first'), criterion('second')] } },
  );

  const instruction = ticketDetail('demo-3403', {
    kind: 'instruction',
    title: 'Instruction title',
    state: 'open',
    parent: 'demo-3402',
  });

  const mounted = await mount([], { width: 80, height: 24 }, [], projectTree(), {
    loadDetail: loadDetailOf([slice, instruction]),
  });

  await mounted.press('s');
  await mounted.press('j');
  await mounted.press('j');
  await mounted.press('j');
  await mounted.press('RETURN');

  const onSlice = linesOf(mounted);

  expect(onSlice.join('\n')).toContain('Slice title');
  expect(onSlice[tabBarIndex(onSlice)]).toMatch(/Criteria 2/);

  await mounted.press(']');

  expect(linesOf(mounted).join('\n')).toContain('Check second');

  await mounted.press('ESCAPE');
  await mounted.press('j');
  await mounted.press(' ');
  await mounted.press('j');
  await mounted.press('RETURN');

  const onInstruction = linesOf(mounted);

  expect(onInstruction.join('\n')).toContain('Instruction title');
  expect(onInstruction[tabBarIndex(onInstruction)]).not.toContain('Criteria');
});

const longTask = (): TicketDetail =>
  ticketDetail(
    'demo-3400',
    { kind: 'task', title: 'Task title', state: 'open', parent: null },
    { body: Array.from({ length: 40 }, (_, index) => `BODY-${index + 1}`).join('\n') },
  );

it('scrolls the tab body one line with j and k in the full-screen detail', async () => {
  const mounted = await mount([needView(0, 'First')], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([longTask()]),
  });

  await mounted.press('RETURN');
  expect(linesOf(mounted).join('\n')).toMatch(/BODY-1\b/);

  await mounted.press('j');
  expect(linesOf(mounted).join('\n')).not.toMatch(/BODY-1\b/);
  expect(linesOf(mounted).join('\n')).toMatch(/BODY-2\b/);

  await mounted.press('k');
  expect(linesOf(mounted).join('\n')).toMatch(/BODY-1\b/);
});

it('scrolls the tab body half a page with Ctrl+D and back with Ctrl+U beside the list', async () => {
  const mounted = await mount([needView(0, 'First')], { width: 120, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([longTask()]),
  });

  const firstBodyRow = () => /BODY-(\d+)\b/.exec(linesOf(mounted).join('\n'))?.[1];

  expect(firstBodyRow()).toBe('1');

  await mounted.press('d', { ctrl: true });

  expect(Number(firstBodyRow())).toBeGreaterThan(2);

  await mounted.press('u', { ctrl: true });

  expect(firstBodyRow()).toBe('1');
});

it('ignores the tab keys while the list hides the detail at 80 columns', async () => {
  const detail = instructionDetail('## Outcome\n\nOUTCOME-MARKER\n');

  const mounted = await mount([needView(0, 'First')], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([detail]),
  });

  await mounted.press(']');
  await mounted.press('RETURN');

  expect(linesOf(mounted).join('\n')).toContain('OUTCOME-MARKER');
});

it('lists every link of a slice on the Links tab and counts them in its label', async () => {
  const slice = ticketDetail(
    'demo-3400',
    { kind: 'slice', title: 'Slice title', state: 'inReview', parent: 'demo-3401' },
    {
      ticket: {
        blockedBy: ['demo-3410'],
        related: ['demo-3411'],
        discoveredFrom: ['demo-3412'],
      },
      children: [
        { id: ticketId('demo-3420'), kind: 'instruction', title: 'First child' },
        { id: ticketId('demo-3421'), kind: 'task', title: 'Second child' },
      ],
      pr: {
        repository: 'acme/app',
        number: 31,
        state: 'open',
        base: 'main',
        head: 'head1',
        mergeCommit: null,
        inTrunk: false,
        checkedAt: '2026-10-20T11:00:00.000Z',
      },
    },
  );

  const mounted = await mount([needView(0, 'First')], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([slice]),
  });

  await mounted.press('RETURN');
  await mounted.press('[');

  const frame = linesOf(mounted).join('\n');

  expect(linesOf(mounted)[tabBarIndex(linesOf(mounted))]).toMatch(/Links 7/);
  expect(frame).toMatch(/Parent\s+demo-3401/);
  expect(frame).toMatch(/demo-3420\s+Instruction\s+First child/);
  expect(frame).toMatch(/demo-3421\s+Task\s+Second child/);
  expect(frame).toMatch(/Blocked by\s+demo-3410/);
  expect(frame).toMatch(/Related\s+demo-3411/);
  expect(frame).toMatch(/Discovered from\s+demo-3412/);
  expect(frame).toMatch(/PR\s+#31/);
});

it('shows only the needs of the selected ticket in the attention block', async () => {
  const other: NeedView = { ...questionOf('OTHER-QUESTION'), id: needView(1, 'Other').id };
  const detail = instructionDetail('');

  const mounted = await mount(
    [questionOf('OWN-QUESTION'), other],
    { width: 80, height: 24 },
    [],
    undefined,
    { loadDetail: loadDetailOf([detail]) },
  );

  await mounted.press('RETURN');

  const frame = linesOf(mounted).join('\n');

  expect(frame).toContain('OWN-QUESTION');
  expect(frame).not.toContain('OTHER-QUESTION');
});

it('shows why the detail of the selected ticket did not load', async () => {
  const mounted = await mount([needView(0, 'First')], { width: 80, height: 24 }, [], undefined, {
    loadDetail: () =>
      Promise.resolve({ ok: false, reason: { code: 'storeError', message: 'DETAIL-FAILED' } }),
  });

  await mounted.press('RETURN');

  expect(linesOf(mounted).join('\n')).toContain('DETAIL-FAILED');
});

it('shows the active Links label in the tab strip of the side pane at 90 by 24', async () => {
  const slice = ticketDetail(
    'demo-3400',
    { kind: 'slice', title: 'Slice title', state: 'active', parent: 'demo-3401' },
    { ticket: { criteria: [criterion('first')] } },
  );

  const mounted = await mount([needView(0, 'First')], { width: 90, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf([slice]),
  });

  const stripOf = () => linesOf(mounted).find((line) => line.includes('Criteria 1')) ?? '';

  // The pane has 30 columns, so the strip keeps whole labels that fit beside the active one.
  expect(stripOf()).toMatch(/\[Overview\] Criteria 1 \s*$/);

  await mounted.press('[');

  const strip = linesOf(mounted).find((line) => /\[\S.*\]/.test(line.slice(line.indexOf('│'))));

  expect(strip).toMatch(/ Activity \[Links 1\]\s*$/);
});

const bodyOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `BODY-${index + 1}`).join('\n');

it('keeps the clamped scroll top when a reload shortens the body and a later one restores it', async () => {
  let body = bodyOf(40);

  const mounted = await mount([needView(0, 'First')], { width: 80, height: 24 }, [], undefined, {
    loadDetail: (rawId) =>
      Promise.resolve({
        ok: true,
        value: ticketDetail(
          rawId,
          { kind: 'task', title: 'Task', state: 'open', parent: null },
          { body },
        ),
      }),
  });

  const firstBodyRow = () => Number(/BODY-(\d+)\b/.exec(linesOf(mounted).join('\n'))?.[1]);

  await mounted.press('RETURN');

  for (let step = 0; step < 20; step += 1) {
    await mounted.press('j');
  }

  expect(firstBodyRow()).toBe(21);

  body = bodyOf(25);
  await mounted.storeChanged();

  const clamped = firstBodyRow();

  expect(clamped).toBeLessThan(21);

  body = bodyOf(40);
  await mounted.storeChanged();

  expect(firstBodyRow()).toBe(clamped);
});
