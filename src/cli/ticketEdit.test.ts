import { expect, it } from 'bun:test';

import {
  failed,
  failureOf,
  makeEffects,
  makeSession,
  makeTicket,
  successOf,
} from './cliHarness.ts';
import type { EffectsOptions, SessionOptions } from './cliHarness.ts';
import { ticketEdit } from './ticketEdit.ts';

const target = makeTicket('demo-3467');

const edit = (
  args: string[],
  json: boolean,
  sessionOptions: SessionOptions = {},
  effectsOptions: EffectsOptions = {},
) => {
  const fakeSession = makeSession({ tickets: [target], ...sessionOptions });
  const fakeEffects = makeEffects({ session: fakeSession, ...effectsOptions });

  const result = ticketEdit({
    args,
    json,
    effects: fakeEffects.effects,
    session: fakeSession.session,
  });

  return { fakeSession, fakeEffects, result };
};

it('writes a changed title and status with the expected hash, then shows the ticket', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'hash-demo-3467', '--title', 'New', '--status', 'draft'],
    true,
  );

  const output = successOf(await result);

  expect(output.json).toMatchObject({ id: 'demo-3467' });
  expect(fakeSession.writes).toHaveLength(1);
  expect(fakeSession.writes[0]?.path).toBe(target.path);
  expect(fakeSession.writes[0]?.expectedHash).toBe('hash-demo-3467');
  expect(fakeSession.writes[0]?.text).toContain('title: New');
  expect(fakeSession.writes[0]?.text).toContain('status: draft');
  expect(fakeSession.writes[0]?.text).toEndWith('A body\n');
  expect(fakeSession.refreshes()).toBe(1);
});

it('keeps the title and status that are not given', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true);

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toContain('status: open');
});

it('keeps the title when only the status is given', async () => {
  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--status', 'draft'], true);

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toContain('title: A title');
});

it('replaces the body from --body-file', async () => {
  const { fakeSession, result } = edit(
    ['demo-3467', '--hash', 'h', '--body-file', '/body.md'],
    true,
    {},
    { files: { '/body.md': 'Fresh\n' } },
  );

  successOf(await result);

  expect(fakeSession.writes[0]?.text).toEndWith('Fresh\n');
  expect(fakeSession.writes[0]?.text).not.toContain('A body');
});

const refusals: [string, string[], boolean][] = [
  ['no ID', ['--hash', 'h', '--title', 'New'], true],
  ['extra positionals', ['demo-3467', 'demo-3468', '--hash', 'h', '--title', 'New'], true],
  ['an unknown option', ['demo-3467', '--bogus'], true],
  ['no field in json mode', ['demo-3467', '--hash', 'h'], true],
  ['a field without --hash', ['demo-3467', '--title', 'New'], false],
  ['an empty title', ['demo-3467', '--hash', 'h', '--title', ''], true],
  ['a closed task', ['demo-3467', '--hash', 'h', '--status', 'closed'], true],
  ['an unknown status', ['demo-3467', '--hash', 'h', '--status', 'nope'], true],
  ['a missing body file', ['demo-3467', '--hash', 'h', '--body-file', '/missing.md'], true],
];

for (const [name, args, json] of refusals) {
  it(`refuses ${name} and writes nothing`, async () => {
    const { fakeSession, fakeEffects, result } = edit(args, json);

    expect(failureOf(await result).code).toBe('invalidArguments');
    expect(fakeSession.writes).toEqual([]);
    expect(fakeEffects.editorPaths).toEqual([]);
  });
}

it('names the missing body file in the error', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h', '--body-file', '/missing.md'], true);

  expect(failureOf(await result).message).toContain('/missing.md');
});

it('gives a message for a rejected front matter', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h', '--status', 'closed'], true);

  const reason = failureOf(await result);

  expect(reason.code).toBe('invalidArguments');
  expect(reason.message).toContain('closed');
});

it('returns notFound naming the ID and writes nothing for an unknown ticket', async () => {
  const { fakeSession, result } = edit(['demo-3468', '--hash', 'h', '--title', 'New'], true);
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
  expect(fakeSession.writes).toEqual([]);
});

it('refuses a ticket that has a parse error and writes nothing', async () => {
  const broken = makeTicket('demo-3467', { error: 'Bad YAML.' });

  const { fakeSession, result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true, {
    tickets: [broken],
  });

  const reason = failureOf(await result);

  expect(reason.code).toBe('parseError');
  expect(reason.message).toContain(broken.path);
  expect(reason.message).toContain('Bad YAML.');
  expect(fakeSession.writes).toEqual([]);
});

it('maps a hash mismatch to changedOnDisk', async () => {
  const { result } = edit(['demo-3467', '--hash', 'old', '--title', 'New'], true, {
    overrides: {
      writeTicketFile: () =>
        Promise.resolve({
          ok: false,
          reason: { kind: 'changedOnDisk', message: 'demo-3467 changed on disk.' },
        }),
    },
  });

  const reason = failureOf(await result);

  expect(reason.code).toBe('changedOnDisk');
  expect(reason.message).toContain('demo-3467');
});

it('maps other write failures to storeError', async () => {
  const kinds = ['notFound', 'failed'] as const;

  for (const kind of kinds) {
    const { result } = edit(['demo-3467', '--hash', 'h', '--title', 'New'], true, {
      overrides: {
        writeTicketFile: () =>
          Promise.resolve({ ok: false, reason: { kind, message: 'Cannot write /store.' } }),
      },
    });

    const reason = failureOf(await result);

    expect(reason.code).toBe('storeError');
    expect(reason.message).toContain('/store');
  }
});

it('opens the editor on the ticket path without --json and shows the result', async () => {
  const { fakeSession, fakeEffects, result } = edit(['demo-3467'], false);
  const output = successOf(await result);

  expect(fakeEffects.editorPaths).toEqual([target.path]);
  expect(output.json).toMatchObject({ id: 'demo-3467' });
  expect(fakeSession.writes).toEqual([]);
  expect(fakeSession.refreshes()).toBe(1);
});

it('does not open the editor for an unknown ticket', async () => {
  const { fakeEffects, result } = edit(['demo-3468'], false);
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('demo-3468');
  expect(fakeEffects.editorPaths).toEqual([]);
});

it('does not open the editor for an invalid ID', async () => {
  const { fakeEffects, result } = edit(['nonsense'], false);
  const reason = failureOf(await result);

  expect(reason.code).toBe('notFound');
  expect(reason.message).toContain('nonsense');
  expect(fakeEffects.editorPaths).toEqual([]);
});

it('returns a storeError when the editor fails', async () => {
  const { result } = edit(
    ['demo-3467'],
    false,
    {},
    {
      overrides: { runEditor: () => failed('Editor exited for /store.') },
    },
  );

  const reason = failureOf(await result);

  expect(reason.code).toBe('storeError');
  expect(reason.message).toContain('/store');
});

it('names --hash when a field edit has no hash', async () => {
  const { result } = edit(['demo-3467', '--title', 'New'], false);

  expect(failureOf(await result).message).toContain('--hash');
});

it('names the fields to give when json mode has none', async () => {
  const { result } = edit(['demo-3467', '--hash', 'h'], true);
  const { message } = failureOf(await result);

  expect(message).toContain('--title');
  expect(message).toContain('--body-file');
});

it('does not look up the path of an invalid ID', async () => {
  const lookups: string[] = [];

  const { fakeEffects, result } = edit(['nonsense'], false, {
    overrides: {
      findTicketPath: (id) => {
        lookups.push(id);

        return { ok: false, reason: { message: 'missing' } };
      },
    },
  });

  await result;

  expect(lookups).toHaveLength(0);
  expect(fakeEffects.editorPaths).toHaveLength(0);
});
