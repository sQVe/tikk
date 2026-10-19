import { expect, it } from 'bun:test';

import { createTicketSlug } from './ticket.ts';

it('makes a lowercase ASCII slug from a title', () => {
  expect(createTicketSlug('Fix: the café bug!')).toBe('fix-the-cafe-bug');
});

it('limits the slug to 50 characters without a trailing dash', () => {
  const slug = createTicketSlug(`${'word '.repeat(20)}end`);

  expect(slug.length).toBeLessThanOrEqual(50);
  expect(slug.endsWith('-')).toBe(false);
  expect(slug.startsWith('word-word')).toBe(true);
});

it('never returns an empty slug', () => {
  expect(createTicketSlug('!!! ???')).not.toBe('');
  expect(createTicketSlug('')).not.toBe('');
});
