import { describe, expect, it } from 'bun:test';

import { selectChecks } from './fact.ts';
import { makeFact } from './factHarness.ts';

const target = (head: string) => ({ repository: 'r', head, base: 'main', changeHash: 'c' });

describe('selectChecks', () => {
  it('marks a check current for its head and stale for another', () => {
    const fact = makeFact('3467', {
      kind: 'check',
      target: target('aaa'),
      command: 'x',
      exitCode: 0,
    });

    expect(selectChecks([fact], 'me-3467', { head: 'aaa' })[0]?.current).toBe(true);
    expect(selectChecks([fact], 'me-3467', { head: 'bbb' })[0]?.current).toBe(false);
  });

  it('marks a check stale for the same head when a given change hash differs', () => {
    const fact = makeFact('3467', {
      kind: 'check',
      target: target('aaa'),
      command: 'x',
      exitCode: 0,
    });

    const same = selectChecks([fact], 'me-3467', { head: 'aaa', changeHash: 'c' });
    const edited = selectChecks([fact], 'me-3467', { head: 'aaa', changeHash: 'd' });

    expect(same[0]?.current).toBe(true);
    expect(edited[0]?.current).toBe(false);
  });

  it('returns only the ticket checks, newest first', () => {
    const older = makeFact('3467', {
      kind: 'check',
      target: target('a'),
      command: 'old',
      exitCode: 0,
    });

    const newer = makeFact('3467', {
      kind: 'check',
      target: target('a'),
      command: 'new',
      exitCode: 1,
      at: '2026-10-20T11:00:00.000Z',
    });

    const other = makeFact('3468', {
      kind: 'check',
      target: target('a'),
      command: 'o',
      exitCode: 0,
    });

    const commands = selectChecks([older, newer, other], 'me-3467', { head: 'a' }).map(
      (c) => c.command,
    );

    expect(commands).toEqual(['new', 'old']);
  });
});
