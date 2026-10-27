import { expect, it } from 'bun:test';

import { messageWindowOf } from './messageWindow.ts';
import type { TuiMessage } from './tuiSession.ts';

const messagesOf = (texts: string[]): TuiMessage[] =>
  texts.map((text, index) => ({ id: index + 1, text }));

it('shows every row without a footer when the history leaves room in the box', () => {
  const messages = messagesOf(['one', 'two']);
  const window = messageWindowOf(messages, 40, 9);

  expect(window.rows).toHaveLength(2);
  expect(window.overflows).toBe(false);
  expect(window.maximumTop).toBe(0);
});

it('does not overflow when the rows exactly fill the box', () => {
  const messages = messagesOf(['one', 'two', 'three']);
  const window = messageWindowOf(messages, 40, 3 + 2);

  expect(window.overflows).toBe(false);
  expect(window.maximumTop).toBe(0);
});

it('scrolls a history that overflows, leaving room for the footer', () => {
  const messages = messagesOf(['one', 'two', 'three', 'four', 'five', 'six']);
  const height = 6;
  const window = messageWindowOf(messages, 40, height);

  expect(window.overflows).toBe(true);
  expect(window.viewportRows).toBe(height - 3);
  expect(window.maximumTop).toBe(window.rows.length - window.viewportRows);
});

it('wraps a long message to fit the box beside its border', () => {
  const window = messageWindowOf(messagesOf(['a'.repeat(30)]), 14, 20);

  expect(window.rows.length).toBeGreaterThan(1);

  for (const row of window.rows) {
    expect(row.text.length).toBeLessThanOrEqual(10);
  }
});
