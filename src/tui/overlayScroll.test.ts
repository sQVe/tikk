import { expect, it } from 'bun:test';

import { topAfter } from './overlayScroll.ts';

it('moves by lines and stops at both ends', () => {
  expect(topAfter(2, { kind: 'lines', lines: 1 }, 10)).toBe(3);
  expect(topAfter(2, { kind: 'lines', lines: -1 }, 10)).toBe(1);
  expect(topAfter(0, { kind: 'lines', lines: -1 }, 10)).toBe(0);
  expect(topAfter(9, { kind: 'lines', lines: 5 }, 10)).toBe(10);
});

it('clamps a top beyond the maximum before it moves', () => {
  expect(topAfter(12, { kind: 'lines', lines: -1 }, 10)).toBe(9);
});

it('jumps to the top or the bottom on an edge move', () => {
  expect(topAfter(4, { kind: 'edge', edge: 'bottom' }, 10)).toBe(10);
  expect(topAfter(4, { kind: 'edge', edge: 'top' }, 10)).toBe(0);
});
