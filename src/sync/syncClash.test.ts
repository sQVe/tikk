import { expect, it } from 'bun:test';

import { resolveIdClashes } from './syncClash.ts';
import { gitOutput, makeSync } from './syncHarness.ts';

const root = '/store';

// Each file's adding commit time, or no entry for a file no commit added yet.
const clashingStore = (addedTimes: Record<string, string>, fileNames: string[]) =>
  makeSync({
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
