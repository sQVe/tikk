import { expect, it } from 'bun:test';

import { resolveIdClashes } from './syncClash.ts';
import { gitOutput, makeSync } from './syncHarness.ts';

const validTicket = '---\nkind: task\ntitle: Valid\nproject: demo\nstatus: open\n---\nBody\n';

const root = '/store';

// Each file's adding commit time, or no entry for a file no commit added yet.
const clashingStore = (
  addedTimes: Record<string, string>,
  fileNames: string[],
  files: Parameters<typeof makeSync>[0] = {},
) =>
  makeSync({
    ...files,
    folders: { '/store/tickets': ['demo'], '/store/tickets/demo': fileNames },
    git: (args) => {
      if (args.includes('log')) {
        const path = args.at(-1) ?? '';

        return gitOutput(addedTimes[path.split('/').at(-1) ?? ''] ?? '');
      }

      return undefined;
    },
  });

const movedFiles = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.gitCalls
    .filter((call) => call.args.includes('mv'))
    .map((call) => call.args.at(-2)?.split('/').at(-1) ?? '');

it('renames the file added later even when its name sorts first', async () => {
  const fake = clashingStore({ 'demo-aaaa-b.md': '100', 'demo-aaaa-a.md': '200' }, [
    'demo-aaaa-a.md',
    'demo-aaaa-b.md',
  ]);

  const result = await resolveIdClashes(fake.functions, root);

  expect(result.ok).toBe(true);
  expect(movedFiles(fake)).toEqual(['demo-aaaa-a.md']);
});

it('renames the file with the later name when both were added at the same time', async () => {
  const fake = clashingStore({ 'demo-aaaa-a.md': '100', 'demo-aaaa-b.md': '100' }, [
    'demo-aaaa-b.md',
    'demo-aaaa-a.md',
  ]);

  await resolveIdClashes(fake.functions, root);

  expect(movedFiles(fake)).toEqual(['demo-aaaa-b.md']);
});

it('renames a file that no commit added, and keeps the committed one', async () => {
  const fake = clashingStore({ 'demo-aaaa-z.md': '100' }, ['demo-aaaa-a.md', 'demo-aaaa-z.md']);

  await resolveIdClashes(fake.functions, root);

  expect(movedFiles(fake)).toEqual(['demo-aaaa-a.md']);
});

const renamedTicketStore = (ageMilliseconds: number) =>
  clashingStore({ 'demo-aaaa-a.md': '100' }, ['demo-aaaa-a.md', 'demo-aaaa-b.md'], {
    now: 100_000,
    files: {
      '/store/tickets/demo/demo-zzzz-b.md': {
        text: validTicket,
        mtimeMs: 100_000 - ageMilliseconds,
      },
    },
  });

const addedPathsOf = (fake: ReturnType<typeof makeSync>): string[] =>
  fake.gitCalls
    .filter((call) => call.args.includes('add'))
    .flatMap((call) => call.args.slice(call.args.indexOf('--') + 1));

it('commits a settled renamed ticket that no commit added with its alias fact', async () => {
  const fake = renamedTicketStore(5000);

  const result = await resolveIdClashes(fake.functions, root);

  expect(addedPathsOf(fake)).toEqual(['facts/fake/2026-10.jsonl', 'tickets/demo/demo-zzzz-b.md']);

  expect(result.ok && result.value.untracked).toEqual([
    {
      from: 'tickets/demo/demo-aaaa-b.md',
      to: 'tickets/demo/demo-zzzz-b.md',
      settled: true,
    },
  ]);
});

it('leaves an unsettled renamed ticket out of the commit and reports it under its new path', async () => {
  const fake = renamedTicketStore(500);

  const result = await resolveIdClashes(fake.functions, root);

  expect(addedPathsOf(fake)).toEqual(['facts/fake/2026-10.jsonl']);
  expect(result.ok && result.value.untracked.map((entry) => entry.settled)).toEqual([false]);
});
