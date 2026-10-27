import { expect, it } from 'bun:test';

import type { NeedView } from '../cli/cli.ts';
import { homeRowsOf } from './homeView.tsx';
import { needView } from './tuiHarness.tsx';

it('gives two items of one reason on one ticket their own row keys', () => {
  const ticket = needView(0, 'Asked instruction');

  const items: NeedView[] = [
    { ...ticket, reason: 'question', item: '0000000000a1', passedUp: true },
    { ...ticket, reason: 'question', item: '0000000000a2', passedUp: true },
    { ...ticket, reason: 'submitted', item: '5ab0000000a1', passedUp: true },
  ];

  const keys = homeRowsOf(items).map((row) => row.key);

  expect(new Set(keys).size).toBe(items.length);
});
