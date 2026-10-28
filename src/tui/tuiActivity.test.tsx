import { afterEach, expect, it } from 'bun:test';

import type { Fact, NeedView, TicketDetail } from '../cli/cli.ts';
import { createTuiFixture, needView, ticketDetail, ticketId } from './tuiHarness.tsx';
import type { TuiFixture } from './tuiHarness.tsx';

type LogFact = Extract<Fact, { kind: 'log' }>;

let fixture: TuiFixture | undefined;

const mount = async (...args: Parameters<typeof createTuiFixture>): Promise<TuiFixture> => {
  fixture = await createTuiFixture(...args);

  return fixture;
};

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

const instructionItem: NeedView = needView(0, 'Instruction title');

const questionFact: LogFact = {
  version: 1,
  ticket: ticketId('demo-3400'),
  at: '2026-10-20T10:00:00.000Z',
  machine: 'laptop',
  kind: 'log',
  type: 'question',
  item: '0123456789ab',
  text: 'QUESTION-MARKER?',
};

const progressFact: LogFact = {
  version: 1,
  ticket: ticketId('demo-3400'),
  at: '2026-10-20T11:00:00.000Z',
  machine: 'laptop',
  kind: 'log',
  type: 'progress',
  text: 'PROGRESS-MARKER',
};

const instructionDetail = (facts: Fact[]): TicketDetail =>
  ticketDetail(
    'demo-3400',
    { kind: 'instruction', title: 'Instruction title', state: 'open', parent: 'demo-3402' },
    { body: '## Outcome\n\nOUTCOME-MARKER\n', facts },
  );

const loadDetailOf = (detail: TicketDetail) => (): Promise<{ ok: true; value: TicketDetail }> =>
  Promise.resolve({ ok: true, value: detail });

const linesOf = (mounted: TuiFixture): string[] => mounted.setup.captureCharFrame().split('\n');

const rowIndex = (lines: readonly string[], text: string): number =>
  lines.findIndex((line) => line.includes(text));

it('lists the progress log above the question on the Activity tab, newest first', async () => {
  const detail = instructionDetail([progressFact, questionFact]);

  const mounted = await mount([instructionItem], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf(detail),
  });

  await mounted.press('RETURN');
  await mounted.press(']');

  const activity = linesOf(mounted);
  const progressRow = rowIndex(activity, 'PROGRESS-MARKER');

  expect(progressRow).toBeGreaterThan(-1);
  expect(rowIndex(activity, 'QUESTION-MARKER')).toBeGreaterThan(progressRow);
  expect(activity.join('\n')).not.toContain('OUTCOME-MARKER');
});

it('counts facts, not wrapped lines, in the Activity tab label', async () => {
  const longProgress: LogFact = {
    ...progressFact,
    text: `LONG-MARKER ${'word '.repeat(60)}`,
  };

  const detail = instructionDetail([questionFact, longProgress]);

  const mounted = await mount([instructionItem], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf(detail),
  });

  await mounted.press('RETURN');

  const tabBar = linesOf(mounted).find((line) => line.includes('Overview'));

  expect(tabBar).toContain('Activity 2');
});

it('shows every line of a multi-line log under its time and kind', async () => {
  const multiline: LogFact = {
    ...progressFact,
    text: 'FIRST-LINE-MARKER\nSECOND-LINE-MARKER',
  };

  const detail = instructionDetail([multiline]);

  const mounted = await mount([instructionItem], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf(detail),
  });

  await mounted.press('RETURN');
  await mounted.press(']');

  const activity = linesOf(mounted);
  const firstRow = rowIndex(activity, 'FIRST-LINE-MARKER');

  expect(rowIndex(activity, '2026-10-20T11:00:00.000Z  log/progress')).toBe(firstRow - 1);
  expect(rowIndex(activity, 'SECOND-LINE-MARKER')).toBe(firstRow + 1);
});

it('shows a fact without text as its time and kind alone, with no detail line under it', async () => {
  const waiting: Fact = {
    version: 1,
    ticket: ticketId('demo-3400'),
    at: '2026-10-20T12:00:00.000Z',
    machine: 'laptop',
    kind: 'waiting',
    waiting: true,
  };

  const detail = instructionDetail([waiting, progressFact]);

  const mounted = await mount([instructionItem], { width: 80, height: 24 }, [], undefined, {
    loadDetail: loadDetailOf(detail),
  });

  await mounted.press('RETURN');
  await mounted.press(']');

  const activity = linesOf(mounted);
  const waitingRow = rowIndex(activity, '2026-10-20T12:00:00.000Z  waiting');

  expect(waitingRow).toBeGreaterThan(-1);
  expect(activity[waitingRow + 1]).toContain('2026-10-20T11:00:00.000Z  log/progress');
});
