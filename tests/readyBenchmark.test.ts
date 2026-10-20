import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');
const idAlphabet = '346789abcdefghijkmnpqrtwxyz';
const ticketCount = 2000;
const runsPerCommand = 3;
const limitMilliseconds = 200;

let home = '';
let work = '';

const run = async (args: string[]): Promise<number> => {
  const child = Bun.spawn(['bun', 'run', entryPath, ...args, '--json'], {
    cwd: work,
    env: { ...process.env, HOME: home, TIKK_HOME: join(home, 'store') },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  return child.exited;
};

const timeRun = async (args: string[]): Promise<number> => {
  const start = performance.now();
  const exitCode = await run(args);

  expect(exitCode).toBe(0);

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
  const folder = join(home, 'store', 'tickets', 'bench');

  const writes = Array.from({ length: ticketCount }, (_, index) =>
    Bun.write(join(folder, `${ticketIdAt(index)}-task-${index}.md`), ticketText(index)),
  );

  await Promise.all(writes);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tikk-bench-'));
  work = join(home, 'work');
  await Bun.write(join(work, '.keep'), '');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it(
  'answers ready and claim in under 200 ms on a store of 2,000 tickets',
  async () => {
    expect(await run(['init'])).toBe(0);
    await writeTickets();
    expect(await run(['ls'])).toBe(0);

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
