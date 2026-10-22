import { describe, expect, it } from 'bun:test';

import { parseFactLine, serializeFactLine } from './fact.ts';

const base = { version: 1, ticket: 'me-3469', at: '2026-10-20T10:00:00.000Z', machine: 'laptop' };

const line = (extra: Record<string, unknown>, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...base, ...extra, ...overrides });

const auditExtra = (verdict: string): Record<string, unknown> => ({
  kind: 'audit',
  head: 'aaa',
  base: 'main',
  verdicts: [{ criterion: 'It works.', verdict, evidence: 'Ran it.' }],
});

describe('parseFactLine', () => {
  it('parses each fact kind', () => {
    const claim = parseFactLine(
      line({ kind: 'claim', holder: 'a', leaseEnd: '2026-10-20T11:00:00.000Z', session: 's' }),
    );

    const release = parseFactLine(line({ kind: 'release', holder: 'a' }));
    const log = parseFactLine(line({ kind: 'log', type: 'progress', text: 'hi' }));
    const accept = parseFactLine(line({ kind: 'accept' }));

    expect([claim.ok, release.ok, log.ok, accept.ok]).toEqual([true, true, true, true]);
  });

  it('round-trips an alias fact and rejects one with no from', () => {
    const parsed = parseFactLine(line({ kind: 'alias', from: 'me-3469' }, { ticket: 'me-4aaa' }));

    if (!parsed.ok) {
      throw new Error(parsed.reason.message);
    }

    expect(parsed.value).toMatchObject({ kind: 'alias', from: 'me-3469', ticket: 'me-4aaa' });
    expect(parseFactLine(serializeFactLine(parsed.value).trim())).toEqual(parsed);
    expect(parseFactLine(line({ kind: 'alias' })).ok).toBe(false);
  });

  it('parses a pr fact and an audit fact', () => {
    const pr = parseFactLine(
      line({
        kind: 'pr',
        repository: 'sqve/tikk',
        number: 7,
        state: 'merged',
        base: 'main',
        head: 'aaa',
        trunk: 'main',
        inTrunk: true,
      }),
    );

    const audit = parseFactLine(line(auditExtra('met')));

    expect([pr.ok, audit.ok]).toEqual([true, true]);
  });

  it('rejects an audit fact whose verdict is not one of the four values', () => {
    expect(parseFactLine(line(auditExtra('maybe'))).ok).toBe(false);
    expect(parseFactLine(line({ ...auditExtra('met'), verdicts: [] })).ok).toBe(false);
  });

  it('returns a failure for invalid JSON', () => {
    const result = parseFactLine('{not json');

    expect(result.ok).toBe(false);
  });

  it('returns a failure for an unknown kind', () => {
    const result = parseFactLine(line({ kind: 'steal' }));

    expect(result.ok).toBe(false);
  });

  it('returns a failure for a version other than 1', () => {
    const result = parseFactLine(line({ kind: 'accept' }, { version: 2 }));

    expect(result.ok).toBe(false);
  });

  it('returns a failure for an invalid machine name', () => {
    const result = parseFactLine(line({ kind: 'accept' }, { machine: 'Bad Name' }));

    expect(result.ok).toBe(false);
  });

  it('returns a failure for a log type that does not exist', () => {
    const result = parseFactLine(line({ kind: 'log', type: 'shout', text: 'x' }));

    expect(result.ok).toBe(false);
  });
});

describe('serializeFactLine', () => {
  it('writes one JSON line that parses back to the same fact', () => {
    const parsed = parseFactLine(line({ kind: 'log', type: 'answer', text: 'yes', holder: 'a' }));

    if (!parsed.ok) {
      throw new Error(parsed.reason.message);
    }

    const text = serializeFactLine(parsed.value);

    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
    expect(parseFactLine(text.trim())).toEqual(parsed);
  });
});
