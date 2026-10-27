import { describe, expect, it } from 'bun:test';

import { parseFactLine, serializeFactLine } from './fact.ts';

const base = { version: 1, ticket: 'me-3469', at: '2026-10-20T10:00:00.000Z', machine: 'laptop' };

const line = (extra: Record<string, unknown>, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...base, ...extra, ...overrides });

const auditExtra = (verdict: string): Record<string, unknown> => ({
  kind: 'audit',
  repository: 'sqve/tikk',
  changeHash: 'hash1',
  head: 'aaa',
  base: 'main',
  verdicts: [{ criterion: 'It works.', verdict, evidence: 'Ran it.' }],
});

const target = { repository: 'r', head: 'a', base: 'main', changeHash: 'c' };

const reviewFinding = (fingerprint: string) => ({
  fingerprint,
  severity: 'low',
  location: 'f',
  claim: 'c',
});

describe('parseFactLine', () => {
  it('parses each fact kind', () => {
    const claim = parseFactLine(
      line({ kind: 'claim', holder: 'a', leaseEnd: '2026-10-20T11:00:00.000Z', session: 's' }),
    );

    const release = parseFactLine(line({ kind: 'release', holder: 'a' }));
    const log = parseFactLine(line({ kind: 'log', type: 'progress', text: 'hi' }));
    const accept = parseFactLine(line({ kind: 'accept', item: '5ab0000000a1' }));

    expect([claim.ok, release.ok, log.ok, accept.ok]).toEqual([true, true, true, true]);
  });

  it('needs an item on a question, answer, submission, accept, pass-up, and reject', () => {
    const withItem = [
      { kind: 'log', type: 'question', text: 'q' },
      { kind: 'log', type: 'answer', text: 'a' },
      { kind: 'log', type: 'submitted', text: '' },
      { kind: 'accept' },
      { kind: 'passUp' },
      { kind: 'reject', reason: 'r' },
    ];

    const parsedWith = withItem.map((extra) =>
      parseFactLine(line({ ...extra, item: 'abc123def456' })),
    );

    const parsedWithout = withItem.map((extra) => parseFactLine(line(extra)));

    expect(parsedWith.map((parsed) => parsed.ok)).toEqual(withItem.map(() => true));
    expect(parsedWithout.map((parsed) => parsed.ok)).toEqual(withItem.map(() => false));
  });

  it('parses a waiting fact with or without text, and refuses an empty text', () => {
    const waiting = parseFactLine(line({ kind: 'waiting', waiting: true, text: 'Pick a name' }));
    const resumed = parseFactLine(line({ kind: 'waiting', waiting: false }));
    const empty = parseFactLine(line({ kind: 'waiting', waiting: true, text: '' }));

    expect([waiting.ok, resumed.ok, empty.ok]).toEqual([true, true, false]);
  });

  it('refuses an item that is not 12 lower-case hex characters, or on a progress log', () => {
    for (const item of ['ABC123DEF456', 'abc123', 'abc123def4567']) {
      expect(parseFactLine(line({ kind: 'passUp', item })).ok).toBe(false);
    }

    const progress = line({ kind: 'log', type: 'progress', text: 'hi', item: 'abc123def456' });

    expect(parseFactLine(progress).ok).toBe(false);
  });

  it('refuses a reject with an empty reason', () => {
    expect(parseFactLine(line({ kind: 'reject', item: 'abc123def456', reason: '' })).ok).toBe(
      false,
    );
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

  it('rejects an audit fact without a change hash or with a malformed repository', () => {
    const { changeHash: _hash, ...withoutHash } = auditExtra('met');

    expect(parseFactLine(line(withoutHash)).ok).toBe(false);
    expect(parseFactLine(line({ ...auditExtra('met'), changeHash: '' })).ok).toBe(false);
    expect(parseFactLine(line({ ...auditExtra('met'), repository: 'tikk' })).ok).toBe(false);
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
    const result = parseFactLine(line({ kind: 'accept', item: '5ab0000000a1' }, { version: 2 }));

    expect(result.ok).toBe(false);
  });

  it('returns a failure for an invalid machine name', () => {
    const result = parseFactLine(
      line({ kind: 'accept', item: '5ab0000000a1' }, { machine: 'Bad Name' }),
    );

    expect(result.ok).toBe(false);
  });

  it('returns a failure for a log type that does not exist', () => {
    const result = parseFactLine(line({ kind: 'log', type: 'shout', text: 'x' }));

    expect(result.ok).toBe(false);
  });
});

describe('serializeFactLine', () => {
  it('writes one JSON line that parses back to the same fact', () => {
    const parsed = parseFactLine(
      line({ kind: 'log', type: 'answer', item: '0000000000a1', text: 'yes', holder: 'a' }),
    );

    if (!parsed.ok) {
      throw new Error(parsed.reason.message);
    }

    const text = serializeFactLine(parsed.value);

    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
    expect(parseFactLine(text.trim())).toEqual(parsed);
  });

  it('parses check, review, and finding facts', () => {
    const check = parseFactLine(line({ kind: 'check', target, command: 'x', exitCode: 0 }));

    const review = parseFactLine(
      line({ kind: 'review', target, captureHash: 'h', mode: 'm', findings: [reviewFinding('a')] }),
    );

    const finding = parseFactLine(
      line({ kind: 'finding', fingerprint: 'a', status: 'blocked', actor: 'x', reason: 'y' }),
    );

    expect([check.ok, review.ok, finding.ok]).toEqual([true, true, true]);
  });

  it('rejects a review with duplicate fingerprints', () => {
    const result = parseFactLine(
      line({
        kind: 'review',
        target,
        captureHash: 'h',
        mode: 'm',
        findings: [reviewFinding('a'), reviewFinding('a')],
      }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a finding with an unknown status', () => {
    const result = parseFactLine(
      line({ kind: 'finding', fingerprint: 'a', status: 'maybe', actor: 'x', reason: 'y' }),
    );

    expect(result.ok).toBe(false);
  });

  it('rejects a check log that is not a SHA-256 hash', () => {
    const result = parseFactLine(
      line({ kind: 'check', target, command: 'x', exitCode: 0, log: 'abc' }),
    );

    expect(result.ok).toBe(false);
  });
});
