import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

const idAlphabet = '346789abcdefghijkmnpqrtwxyz';
const ticketCount = 2000;
const factsPerTask = 10;
const runsPerCommand = 3;
const limitMilliseconds = 200;

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const timeRun = async (args: string[]): Promise<number> => {
  const start = performance.now();

  await cli().runChecked(args);

  return performance.now() - start;
};

const median = (values: number[]): number => {
  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const ticketIdAt = (index: number): string => {
  let suffix = '';
  let rest = index;

  for (let position = 0; position < 4; position += 1) {
    suffix = `${idAlphabet[rest % idAlphabet.length] ?? ''}${suffix}`;
    rest = Math.floor(rest / idAlphabet.length);
  }

  return `bench-${suffix}`;
};

// Every tenth task is blocked by the task before it, so the ready rule has blockers to resolve.
const ticketText = (index: number): string => {
  const blockedBy = index % 10 === 9 ? `\n  - ${ticketIdAt(index - 1)}` : ' []';

  return `---\nkind: task\ntitle: Task ${index}\nproject: bench\nblockedBy:${blockedBy}\nstatus: open\n---\nBody ${index}\n`;
};

const writeTickets = async (): Promise<void> => {
  const folder = join(cli().storePath, 'tickets', 'bench');

  const writes = Array.from({ length: ticketCount }, (_, index) =>
    Bun.write(join(folder, `${ticketIdAt(index)}-task-${index}.md`), ticketText(index)),
  );

  await Promise.all(writes);
};

// Each task has an old claim and its release, then progress notes. Every task stays open, so the
// ready rule reads the whole history.
const factFields = (index: number, step: number): Record<string, unknown> => {
  if (step === 0) {
    return { kind: 'claim', holder: 'old', leaseEnd: '2026-10-01T01:00:00.000Z' };
  }

  if (step === 1) {
    return { kind: 'release', holder: 'old' };
  }

  return { kind: 'log', type: 'progress', text: `Note ${step} of task ${index}` };
};

const writeFacts = async (): Promise<void> => {
  const lines: string[] = [];

  for (let index = 0; index < ticketCount; index += 1) {
    for (let step = 0; step < factsPerTask; step += 1) {
      const at = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, index * factsPerTask + step)).toISOString();

      lines.push(
        JSON.stringify({
          version: 1,
          ticket: ticketIdAt(index),
          at,
          machine: 'bench',
          ...factFields(index, step),
        }),
      );
    }
  }

  await Bun.write(
    join(cli().storePath, 'facts', 'bench', '2026-10.jsonl'),
    `${lines.join('\n')}\n`,
  );
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-bench-');
});

afterEach(async () => {
  await fixture?.cleanup();
});

it(
  'answers ready and claim in under 200 ms on a store of 2,000 tickets',
  async () => {
    await cli().runChecked(['init']);
    await writeTickets();
    await writeFacts();
    await cli().runChecked(['ls']);

    const readyTimes: number[] = [];
    const claimTimes: number[] = [];

    for (let index = 0; index < runsPerCommand; index += 1) {
      readyTimes.push(await timeRun(['ready']));
    }

    for (let index = 0; index < runsPerCommand; index += 1) {
      claimTimes.push(await timeRun(['claim', ticketIdAt(index), '--holder', 'bench']));
    }

    expect(median(readyTimes)).toBeLessThan(limitMilliseconds);
    expect(median(claimTimes)).toBeLessThan(limitMilliseconds);
  },
  { timeout: 60_000 },
);
