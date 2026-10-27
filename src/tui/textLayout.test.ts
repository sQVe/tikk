import { expect, it } from 'bun:test';

import { fitText, wrapCells } from './textLayout.ts';

it('keeps text that fits exactly and clips a longer text with an ellipsis', () => {
  expect(fitText('abc', 3)).toBe('abc');
  expect(fitText('abcdef', 4)).toBe('abc…');
});

it('returns nothing when no column is available', () => {
  expect(fitText('abc', 0)).toBe('');
});

it('wraps text at the column width without an empty leading line', () => {
  expect(wrapCells('abcdef', 4)).toEqual(['abcd', 'ef']);
  expect(wrapCells('ab', 1)).toEqual(['a', 'b']);
  expect(wrapCells('ab', 4)).toEqual(['ab']);
});

it('clips to one ellipsis cell when only one column is left', () => {
  expect(fitText('abc', 1)).toBe('…');
});

it('moves a wide character that does not fit onto its own line', () => {
  expect(wrapCells('漢字', 1)).toEqual(['漢', '字']);
});
