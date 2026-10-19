import { expect, it } from 'bun:test';

import {
  invalidArguments,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import { makeEffects } from './cliHarness.ts';

it('parses options, positionals, and the json flag', () => {
  const parsed = parseCommandArguments(['task', 'Title', '--json', '--name', 'value'], {
    name: { type: 'string' },
  });

  expect(parsed).toEqual({
    ok: true,
    value: { values: { json: true, name: 'value' }, positionals: ['task', 'Title'] },
  });
});

it('rejects an unknown option and names it', () => {
  const parsed = parseCommandArguments(['--bogus'], {});

  expect(parsed.ok).toBe(false);

  if (!parsed.ok) {
    expect(parsed.reason.code).toBe('invalidArguments');
    expect(parsed.reason.message).toContain('--bogus');
  }
});

it('rejects an option that is missing its value', () => {
  const parsed = parseCommandArguments(['--name'], { name: { type: 'string' } });

  expect(parsed.ok).toBe(false);

  if (!parsed.ok) {
    expect(parsed.reason.message).toContain('--name');
  }
});

it('builds an invalidArguments failure with the given message', () => {
  const failure = invalidArguments('Give --hash.');

  expect(failure.ok).toBe(false);
  expect(failure.reason.code).toBe('invalidArguments');
  expect(failure.reason.message).toContain('--hash');
});

it('reads a string value and ignores boolean or missing values', () => {
  const values = { name: 'value', flag: true };

  expect(stringValue(values, 'name')).toBe('value');
  expect(stringValue(values, 'flag')).toBeUndefined();
  expect(stringValue(values, 'other')).toBeUndefined();
});

it('reads a body file through the effects', async () => {
  const { effects } = makeEffects({ files: { '/body.md': 'text' } });

  expect(await readBodyFile(effects, '/body.md')).toEqual({ ok: true, value: 'text' });
});

it('reads an empty body file as an empty string', async () => {
  const { effects } = makeEffects({ files: { '/body.md': '' } });

  expect(await readBodyFile(effects, '/body.md')).toEqual({ ok: true, value: '' });
});

it('fails with a message that names a body file it cannot read', async () => {
  const { effects } = makeEffects();
  const result = await readBodyFile(effects, '/missing.md');

  expect(result.ok).toBe(false);

  if (!result.ok) {
    expect(result.reason.code).toBe('invalidArguments');
    expect(result.reason.message).toContain('/missing.md');
  }
});
