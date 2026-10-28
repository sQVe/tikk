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
    const reply = replies[command];

    return Promise.resolve(
      reply === undefined ? gitFailure(`no reply for ${command}`) : gitOutput(reply),
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

  const references = await movedFactReferences(git, root, renamedPath, clashId());

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

  const references = await movedFactReferences(git, root, renamedPath, clashId());

  expect(references).toEqual({ ok: true, value: [] });
});

it('lists nothing when both parents have the renamed file', async () => {
  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: `${renamedPath}\0`,
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: `${renamedPath}\0`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId());

  expect(references).toEqual({ ok: true, value: [] });
});

it('lists the local lines when neither parent has the renamed file yet', async () => {
  const pending = progressLine('demo-aaaa', 'Pending branch progress');

  const git = gitReplies({
    'rev-list --first-parent --merges --parents HEAD': 'merge left right\n',
    [`ls-tree -r -z --name-only left -- ${renamedPath}`]: '',
    [`ls-tree -r -z --name-only right -- ${renamedPath}`]: '',
    'ls-tree -r -z --name-only left -- facts': 'facts/second/2026-10.jsonl\0',
    'ls-tree -r -z --name-only right -- facts': '',
    'show left:facts/second/2026-10.jsonl': `${pending}\n`,
  });

  const references = await movedFactReferences(git, root, renamedPath, clashId());

  expect(references).toEqual({ ok: true, value: [{ path: 'second/2026-10.jsonl', line: 1 }] });
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

  const references = await movedFactReferences(git, root, renamedPath, clashId());

  expect(references).toEqual({
    ok: true,
    value: [
      { path: 'second/2026-10.jsonl', line: 1 },
      { path: 'second/2026-10.jsonl', line: 2 },
    ],
  });
});
