import { describe, expect, it } from 'bun:test';

import { selectFindings } from './fact.ts';
import { makeFact } from './factHarness.ts';

const target = { repository: 'r', head: 'a', base: 'main', changeHash: 'c' };

const review = (hour: number, fingerprints: string[]) =>
  makeFact('3467', {
    kind: 'review',
    target,
    captureHash: 'h',
    mode: 'm',
    at: `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`,
    findings: fingerprints.map((fingerprint) => ({
      fingerprint,
      severity: 'high',
      location: `file-${hour}`,
      claim: `claim-${hour}`,
    })),
  });

const status = (hour: number, fingerprint: string, value: string) =>
  makeFact('3467', {
    kind: 'finding',
    fingerprint,
    status: value,
    actor: 'a',
    reason: 'r',
    at: `2026-10-20T${String(hour).padStart(2, '0')}:00:00.000Z`,
  });

const matches = (facts: ReturnType<typeof review>[]) =>
  Object.fromEntries(selectFindings(facts, 'me-3467').map((f) => [f.fingerprint, f.match]));

describe('selectFindings', () => {
  it('matches fingerprints against the newest review', () => {
    const facts = [review(8, ['kept', 'gone']), review(9, ['kept', 'fresh'])];

    expect(matches(facts)).toEqual({ kept: 'unchanged', gone: 'absent', fresh: 'new' });
  });

  it('takes fields from the newest review that holds the fingerprint', () => {
    const [kept] = selectFindings([review(8, ['kept']), review(9, ['kept'])], 'me-3467');

    expect(kept).toMatchObject({ location: 'file-9', claim: 'claim-9', status: 'open' });
  });

  it('sets the status from the newest finding fact and ignores unknown fingerprints', () => {
    const facts = [
      review(8, ['kept']),
      status(9, 'kept', 'blocked'),
      status(10, 'kept', 'fixed'),
      status(11, 'ghost', 'fixed'),
    ];

    const found = selectFindings(facts, 'me-3467');

    expect(found.map((f) => [f.fingerprint, f.status])).toEqual([['kept', 'fixed']]);
  });
});
