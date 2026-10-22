import { describe, expect, it } from 'bun:test';

import { redactSecrets } from './fact.ts';

describe('redactSecrets', () => {
  it('replaces a GitHub token and keeps the rest of the line', () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;

    expect(redactSecrets(`push with ${token} failed`)).toBe('push with [redacted] failed');
  });

  it.each([
    ['gho', `gho_${'a'.repeat(30)}`],
    ['ghu', `ghu_${'a'.repeat(30)}`],
    ['ghs', `ghs_${'a'.repeat(30)}`],
    ['ghr', `ghr_${'a'.repeat(30)}`],
    ['fine-grained', `github_pat_${'a'.repeat(30)}`],
    ['AWS', 'AKIAABCDEFGHIJKLMNOP'],
    ['sk key', `sk-${'a'.repeat(30)}`],
    ['Slack', 'xoxb-1234567890-abcdef'],
    ['Bearer', 'Bearer abcdefghij1234567890'],
    ['lower-case bearer', 'bearer abcdefghij1234567890'],
    ['upper-case bearer', 'BEARER abcdefghij1234567890'],
    ['PEM', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nabc=\n-----END RSA PRIVATE KEY-----'],
  ])('replaces a %s secret', (_name, secret) => {
    expect(redactSecrets(`before ${secret} after`)).toBe('before [redacted] after');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactSecrets('plain log line')).toBe('plain log line');
  });
});
