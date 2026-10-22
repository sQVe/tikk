import { expect, it } from 'bun:test';

import { parseReviewFindings } from './reviewFindings.ts';

const finding = {
  fingerprint: 'fp-1',
  severity: 'high' as const,
  location: 'a.ts:1',
  claim: 'Wrong',
};

it('parses a list of findings', () => {
  const parsed = parseReviewFindings(JSON.stringify([finding]));

  expect(parsed).toEqual({ ok: true, value: [finding] });
});

it('refuses text that is not JSON, and findings of a bad shape', () => {
  const badSeverity = JSON.stringify([{ ...finding, severity: 'huge' }]);
  const extraField = JSON.stringify([{ ...finding, extra: 1 }]);

  for (const text of ['nope', '{}', badSeverity, extraField]) {
    expect(parseReviewFindings(text).ok).toBe(false);
  }
});
