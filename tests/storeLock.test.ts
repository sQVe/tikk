import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Interval {
  start: number;
  end: number;
}

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tikk-lock-'));
  await mkdir(join(root, '.git'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const runChild = async (): Promise<Interval> => {
  const child = Bun.spawn(['bun', 'run', 'tests/storeLockChild.ts', root, '200'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });

  return JSON.parse(stdout) as Interval;
};

it('keeps the hold intervals of two processes apart', async () => {
  const [first, second] = await Promise.all([runChild(), runChild()]);
  const [earlier, later] = first.start <= second.start ? [first, second] : [second, first];

  expect(earlier.end - earlier.start).toBeGreaterThanOrEqual(200);
  expect(later.end - later.start).toBeGreaterThanOrEqual(200);
  expect(earlier.end).toBeLessThanOrEqual(later.start);
  expect(existsSync(join(root, '.git', 'tikk.lock'))).toBe(false);
});
