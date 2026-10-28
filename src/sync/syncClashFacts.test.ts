import { expect, it } from 'bun:test';

import { invariant } from '../invariant.ts';
import { parseTicketId } from '../ticket/ticket.ts';
import { movedFactReferences } from './syncClashFacts.ts';
import { gitFailure, gitOutput } from './syncHarness.ts';

const root = '/store';
const renamedPath = 'tickets/demo/demo-aaaa-b.md';

const clashId = () => {
  const parsed = parseTicketId('demo-aaaa');

  invariant(parsed.ok, 'The test ID should parse.');

  return parsed.value;
};

const progressLine = (ticket: string, text: string): string =>
  JSON.stringify({
    version: 1,
    ticket,
    at: '2026-10-05T10:00:00.000Z',
    machine: 'second',
    kind: 'log',
    type: 'progress',
    text,
  });

const gitReplies = (replies: Record<string, string>) => ({
  runGit: (args: string[]) => {
    const command = args.slice(args.indexOf('-C') + 2).join(' ');

    const defaults = {
      'ls-tree -r -z --name-only HEAD -- facts': '',
      'ls-tree -r -z --name-only HEAD -- tickets': '',
      [`ls-tree -r -z --name-only HEAD -- ${renamedPath}`]: `${renamedPath}\0`,
    };

    const reply = { ...defaults, ...replies }[command];

    return Promise.resolve(
      reply === undefined ? gitFailure(`no reply for ${command}`) : gitOutput(reply),
    );
  },
  readFile: (path: string) => {
    const reply = replies[`show HEAD:${path.slice(root.length + 1)}`];

    return reply === undefined
      ? Promise.reject(new Error(`no file ${path}`))
      : Promise.resolve(reply);
  },
  readdir: (directory: string) => {
    const listed = replies[`ls-tree -r -z --name-only HEAD -- ${directory.slice(root.length + 1)}`];

    return Promise.resolve(
      (listed ?? '')
        .split('\0')
        .filter((path) => path !== '')
        .map((path) => path.split('/').at(-1) ?? ''),
    );
  },
});

const mergeOf = (left: string, right: string, extra: Record<string, string>) => ({
  'rev-list --first-parent --merges --parents HEAD': `merge ${left} ${right}\n`,
  [`ls-tree -r -z --name-only ${left} -- ${renamedPath}`]: `${renamedPath}\0`,
  [`ls-tree -r -z --name-only ${right} -- ${renamedPath}`]: '',
  ...extra,
});

it('lists the lines the renamed side adds with the clashing ID, by file and line', async () => {
  const shared = progressLine('demo-aaaa', 'shared');
  const renamedOnly = progressLine('demo-aaaa', 'renamed side only');
  const otherTicket = progressLine('demo-zzzz', 'another ticket');

  const git = gitReplies(
    mergeOf('left', 'right', {
      'ls-tree -r -z --name-only left -- facts':
        'facts/second/2026-10.jsonl\0facts/second/2026-11.jsonl\0',
      'ls-tree -r -z --name-only right -- facts': 'facts/second/2026-10.jsonl\0',
      'show left:facts/second/2026-10.jsonl': `${shared}\n${renamedOnly}\n${otherTicket}\n`,
      'show right:facts/second/2026-10.jsonl': `${shared}\n`,
      'show left:facts/second/2026-11.jsonl': `${renamedOnly}\n`,
    }),
  );

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({
    ok: true,
    value: [
      { path: 'second/2026-10.jsonl', line: 2 },
      { path: 'second/2026-11.jsonl', line: 1 },
    ],
  });
});

it('lists nothing when HEAD is not a merge', async () => {
  const git = gitReplies({ 'rev-list --first-parent --merges --parents HEAD': 'commit\n' });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({ ok: true, value: [] });
});

it('lists nothing when both parents have the renamed file', async () => {
  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: `${renamedPath}\0`,
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: `${renamedPath}\0`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({ ok: true, value: [] });
});

it("lists this machine's old-ID lines from disk when neither parent has the renamed file yet", async () => {
  const pending = progressLine('demo-aaaa', 'Pending branch progress');
  const otherTicket = progressLine('demo-zzzz', 'another ticket');

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only HEAD -- ${renamedPath}`]: '',
    'ls-tree -r -z --name-only HEAD -- facts/second': 'facts/second/2026-10.jsonl\0',
    'show HEAD:facts/second/2026-10.jsonl': `${otherTicket}\n${pending}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({ ok: true, value: [{ path: 'second/2026-10.jsonl', line: 2 }] });
});

it('reads lines the renamed side adds after the merge that brought the file in, on its newest parent', async () => {
  const renamedLine = progressLine('demo-aaaa', 'Renamed side only');
  const laterLine = progressLine('demo-aaaa', 'Added after the newer merge');

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD':
      'newer newer-local newer-remote\nolder left right\n',
    [`ls-tree -r -z --name-only newer-local -- ${renamedPath}`]: `${renamedPath}\0`,
    [`ls-tree -r -z --name-only newer-remote -- ${renamedPath}`]: `${renamedPath}\0`,
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: `${renamedPath}\0`,
    'ls-tree -r -z --name-only right -- facts': 'facts/second/2026-10.jsonl\0',
    'ls-tree -r -z --name-only newer-remote -- facts': 'facts/second/2026-10.jsonl\0',
    'ls-tree -r -z --name-only left -- facts': '',
    'show right:facts/second/2026-10.jsonl': `${renamedLine}\n`,
    'show newer-remote:facts/second/2026-10.jsonl': `${renamedLine}\n${laterLine}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({
    ok: true,
    value: [
      { path: 'second/2026-10.jsonl', line: 1 },
      { path: 'second/2026-10.jsonl', line: 2 },
    ],
  });
});

it('leaves out a line an earlier alias already moves when a later clash renames a pending ticket', async () => {
  const movedEarlier = progressLine('demo-aaaa', 'Moved by the earlier alias');
  const newLine = progressLine('demo-aaaa', 'Added before the second clash');

  const earlierAlias = JSON.stringify({
    version: 1,
    ticket: 'demo-zzzz',
    at: '2026-10-20T10:00:00.000Z',
    machine: 'first',
    kind: 'alias',
    from: 'demo-aaaa',
    movedFacts: [{ path: 'second/2026-10.jsonl', line: 1 }],
  });

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: '',
    'ls-tree -r -z --name-only HEAD -- facts':
      'facts/second/2026-10.jsonl\0facts/first/2026-10.jsonl\0',
    'ls-tree -r -z --name-only HEAD -- facts/second': 'facts/second/2026-10.jsonl\0',
    'ls-tree -r -z --name-only HEAD -- tickets': 'tickets/demo/demo-zzzz-x.md\0',
    'show HEAD:facts/second/2026-10.jsonl': `${movedEarlier}\n${newLine}\n`,
    'show HEAD:facts/first/2026-10.jsonl': `${earlierAlias}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({ ok: true, value: [{ path: 'second/2026-10.jsonl', line: 2 }] });
});

it("lists this machine's old-ID lines when a fast-forward leaves the renamed file pending", async () => {
  const pending = progressLine('demo-aaaa', 'Fast-forward pending progress');

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': '',
    [`ls-tree -r -z --name-only HEAD -- ${renamedPath}`]: '',
    'ls-tree -r -z --name-only HEAD -- facts/second': 'facts/second/2026-10.jsonl\0',
    'show HEAD:facts/second/2026-10.jsonl': `${pending}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({ ok: true, value: [{ path: 'second/2026-10.jsonl', line: 1 }] });
});

it('does not skip a line that an alias moved when the alias new ticket is not in HEAD', async () => {
  const newLine = progressLine('demo-aaaa', 'Added after the abandoned alias');

  const abandonedAlias = JSON.stringify({
    version: 1,
    ticket: 'demo-zzzz',
    at: '2026-10-20T10:00:00.000Z',
    machine: 'first',
    kind: 'alias',
    from: 'demo-aaaa',
    movedFacts: [{ path: 'second/2026-10.jsonl', line: 1 }],
  });

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: '',
    'ls-tree -r -z --name-only HEAD -- tickets': '',
    'ls-tree -r -z --name-only HEAD -- facts':
      'facts/second/2026-10.jsonl\0facts/first/2026-10.jsonl\0',
    'ls-tree -r -z --name-only HEAD -- facts/second': 'facts/second/2026-10.jsonl\0',
    'show HEAD:facts/second/2026-10.jsonl': `${progressLine('demo-aaaa', 'Moved by the abandoned alias')}\n${newLine}\n`,
    'show HEAD:facts/first/2026-10.jsonl': `${abandonedAlias}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId(), 'second');

  expect(references).toEqual({
    ok: true,
    value: [
      { path: 'second/2026-10.jsonl', line: 1 },
      { path: 'second/2026-10.jsonl', line: 2 },
    ],
  });
});
