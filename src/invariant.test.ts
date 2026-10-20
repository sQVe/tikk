import { expect, it } from 'bun:test';

import { invariant } from './invariant.ts';

it('does nothing when the condition holds', () => {
  expect(() => {
    invariant(true, 'unused');
  }).not.toThrow();
});

it('throws an error that carries the message when the condition fails', () => {
  expect(() => {
    invariant(false, 'the cache row is broken');
  }).toThrow('the cache row is broken');
});
