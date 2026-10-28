import { afterEach, expect, it } from 'bun:test';

import { TextAttributes } from '@opentui/core';
import type { CapturedSpan } from '@opentui/core';

import { createTuiFixture, needView } from './tuiHarness.tsx';
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

const items = [needView(0, 'First'), needView(1, 'Second')];

const spansOf = (setup: TuiFixture['setup']): CapturedSpan[] =>
  setup.captureSpans().lines.flatMap((line) => line.spans);

const visibleSpansOf = (setup: TuiFixture['setup']): CapturedSpan[] =>
  spansOf(setup).filter((span) => span.text.trim() !== '');

const usesFixedForeground = (span: CapturedSpan): boolean => span.fg.intent === 'rgb';

const usesFixedBackground = (span: CapturedSpan): boolean =>
  span.bg.intent === 'rgb' && span.bg.a > 0;

const spanWith = (setup: TuiFixture['setup'], text: string): CapturedSpan | undefined =>
  spansOf(setup).find((span) => span.text.includes(text));

const isBold = (span: CapturedSpan | undefined): boolean =>
  ((span?.attributes ?? 0) & TextAttributes.BOLD) !== 0;

it('draws the home view, the detail pane, and the status line in terminal colors', async () => {
  const { setup } = await mount(items, { width: 120, height: 12 });

  expect(setup.captureCharFrame()).toContain('demo-3400');
  expect(visibleSpansOf(setup).filter(usesFixedForeground)).toEqual([]);
  expect(spansOf(setup).filter(usesFixedBackground)).toEqual([]);
});

it.each([
  ['help', ['?']],
  ['messages', ['g', 'm']],
])('draws the %s overlay on the terminal background in terminal colors', async (_, keys) => {
  const { setup, press } = await mount(items, { width: 120, height: 30 }, ['Sync failed.']);

  for (const key of keys) {
    await press(key);
  }

  const title = keys.length === 1 ? 'Help' : 'Messages';

  expect(spanWith(setup, title)?.bg.intent).toBe('default');
  expect(visibleSpansOf(setup).filter(usesFixedForeground)).toEqual([]);
  expect(spansOf(setup).filter(usesFixedBackground)).toEqual([]);
});

it('covers the list rows with the messages overlay', async () => {
  const { setup, press } = await mount(items, { width: 120, height: 12 });

  await press('g');
  await press('m');

  expect(setup.captureCharFrame()).not.toContain('Second');
});

it('marks only the selected row in bold', async () => {
  const { setup } = await mount(items, { width: 120, height: 12 });

  expect(isBold(spanWith(setup, 'submitted  First'))).toBe(true);
  expect(isBold(spanWith(setup, 'submitted  Second'))).toBe(false);
});
