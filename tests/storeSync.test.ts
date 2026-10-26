import { afterEach, beforeEach, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { ticketFolderPath } from '../src/store/storePaths.ts';
import { parseProjectName, parseTicketId } from '../src/ticket/ticket.ts';
import { createCliFixture, createCloneFixtures } from './cliFixture.ts';
import type { CliFixture, CloneFixtures } from './cliFixture.ts';

interface ShownInstruction {
  id: string;
  path: string;
  state: string;
  claim: { holder: string } | null;
}

interface SyncReport {
  committed: boolean;
  pending: string[];
  fetched: boolean;
  merged: boolean;
  pushed: boolean;
}

interface InitReport {
  store: string;
  created: boolean;
  remote: string;
  pushed: boolean;
}

interface AliasSyncReport extends SyncReport {
  aliases: { from: string; to: string; path: string }[];
}

// Each test runs the CLI and Git in child processes, which takes seconds on a busy machine.
setDefaultTimeout(30_000);

let clones: CloneFixtures | undefined;
let single: CliFixture | undefined;

const clonePair = (): CloneFixtures => {
  invariant(clones !== undefined, 'The clone fixtures should be set up.');

  return clones;
};

const singleFixture = (): CliFixture => {
  invariant(single !== undefined, 'The single fixture should be set up.');

  return single;
};

beforeEach(async () => {
  clones = await createCloneFixtures('tikk-sync-');
  single = await createCliFixture('tikk-sync-single-');
});

afterEach(async () => {
  await clones?.cleanup();
  await single?.cleanup();
});

const ageFile = async (path: string): Promise<void> => {
  const past = new Date(Date.now() - 5000);

  await utimes(path, past, past);
};

const folderOf = (storePath: string, id: string): string => {
  const project = parseProjectName('demo');
  const ticketId = parseTicketId(id);

  invariant(project.ok && ticketId.ok, 'The test project and ticket ID must be valid.');

  return ticketFolderPath({ root: storePath }, project.value, ticketId.value);
};

const createInstructionIn = async (
  fixture: CliFixture,
  title: string,
): Promise<ShownInstruction> => {
  const parent = await fixture.runJson<ShownInstruction>([
    'new',
    'slice',
    'Parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);

  return fixture.runJson<ShownInstruction>(['new', 'instruction', title, '--parent', parent.id]);
};

const createSettledInstruction = async (
  fixture: CliFixture,
  title: string,
): Promise<ShownInstruction> => {
  const instruction = await createInstructionIn(fixture, title);

  await ageFile(instruction.path);

  return instruction;
};

const readAllFacts = async (fixture: CliFixture): Promise<string> => {
  const factsDirectory = join(fixture.storePath, 'facts');
  const entries = await readdir(factsDirectory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.jsonl'));

  const texts = await Promise.all(
    files.map((file) => readFile(join(factsDirectory, file), 'utf8')),
  );

  return texts.join('');
};

const gitOutput = async (root: string, args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  invariant(exitCode === 0, `git ${args.join(' ')} exited with ${exitCode}.`);

  return stdout;
};

it('two clones that each add facts offline sync with no conflict, and both see all facts', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const firstInstruction = await createSettledInstruction(first, 'First instruction');
  const secondInstruction = await createSettledInstruction(second, 'Second instruction');

  await first.runChecked(['claim', firstInstruction.id, '--holder', 'first-agent']);

  await first.runChecked([
    'log',
    firstInstruction.id,
    '--type',
    'progress',
    '--text',
    'first progress',
  ]);

  await second.runChecked(['claim', secondInstruction.id, '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    secondInstruction.id,
    '--type',
    'progress',
    '--text',
    'second progress',
  ]);

  for (const fixture of [first, second, first, second]) {
    const report = await fixture.runJson<SyncReport>(['sync']);

    expect(report.pending).toEqual([]);
  }

  for (const fixture of [first, second]) {
    const shownFirst = await fixture.runJson<ShownInstruction>(['show', firstInstruction.id]);
    const shownSecond = await fixture.runJson<ShownInstruction>(['show', secondInstruction.id]);
    const facts = await readAllFacts(fixture);

    expect(shownFirst).toMatchObject({ state: 'active', claim: { holder: 'first-agent' } });
    expect(shownSecond).toMatchObject({ state: 'active', claim: { holder: 'second-agent' } });
    expect(facts).toContain('first progress');
    expect(facts).toContain('second progress');
  }
});

it('two clones that edit one ticket offline stop the sync and name the file', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const instruction = await createSettledInstruction(first, 'Shared instruction');

  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  const shown = await second.runJson<ShownInstruction>(['show', instruction.id]);
  const ticketPath = relative(second.storePath, shown.path);

  for (const [fixture, body] of [
    [first, 'Edited on the first machine.'],
    [second, 'Edited on the second machine.'],
  ] as const) {
    const path = join(fixture.storePath, ticketPath);
    const text = await readFile(path, 'utf8');

    await writeFile(path, `${text}\n${body}\n`);
    await ageFile(path);
  }

  await first.runChecked(['sync']);

  const result = await second.run(['sync']);
  const parsed = JSON.parse(result.stdout) as { error: { code: string; message: string } };

  expect(result.exitCode).not.toBe(0);
  expect(parsed.error.code).toBe('conflict');
  expect(parsed.error.message).toContain(ticketPath);
  expect(existsSync(join(second.storePath, '.git', 'MERGE_HEAD'))).toBe(false);

  const again = await second.run(['sync']);
  const repeated = JSON.parse(again.stdout) as { error: { code: string; message: string } };

  expect(repeated.error.code).toBe('conflict');
  expect(repeated.error.message).toContain(ticketPath);
});

it('leaves a fresh ticket file and one that does not parse out of the commit as pending', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const settled = await createSettledInstruction(fixture, 'Settled instruction');
  const fresh = await createInstructionIn(fixture, 'Fresh instruction');
  const brokenCopy = join(dirname(settled.path), 'broken.md');

  await writeFile(brokenCopy, 'no front matter here\n');
  await ageFile(brokenCopy);

  const report = await fixture.runJson<SyncReport>(['sync']);
  const tracked = await gitOutput(fixture.storePath, ['ls-files']);
  const freshPath = relative(fixture.storePath, fresh.path);
  const brokenRelative = relative(fixture.storePath, brokenCopy);
  const settledPath = relative(fixture.storePath, settled.path);

  expect(report.committed).toBe(true);
  expect(report.pending.toSorted()).toEqual([brokenRelative, freshPath].toSorted());
  expect(tracked).toContain(settledPath);
  expect(tracked).not.toContain(freshPath);
  expect(tracked).not.toContain(brokenRelative);
});

it("a design.md in a plan's folder syncs to a second clone", async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const plan = await first.runJson<ShownInstruction>([
    'new',
    'plan',
    'Design plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const designPath = join(folderOf(first.storePath, plan.id), 'design.md');
  const designText = '# Design\n\nNot ticket front matter.\n';

  await ageFile(plan.path);
  await mkdir(dirname(designPath), { recursive: true });
  await writeFile(designPath, designText);

  const firstReport = await first.runJson<SyncReport>(['sync']);
  await second.runChecked(['sync']);

  const syncedPath = join(second.storePath, relative(first.storePath, designPath));

  expect(firstReport.pending).toEqual([]);
  expect(await readFile(syncedPath, 'utf8')).toBe(designText);
});

it("a binary file in a plan's folder syncs to a second clone byte for byte", async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const plan = await first.runJson<ShownInstruction>([
    'new',
    'plan',
    'Binary plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const imagePath = join(folderOf(first.storePath, plan.id), 'diagram.png');
  const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x0a, 0xc3]);

  await ageFile(plan.path);
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, imageBytes);

  const firstReport = await first.runJson<SyncReport>(['sync']);
  await second.runChecked(['sync']);

  const syncedPath = join(second.storePath, relative(first.storePath, imagePath));

  expect(firstReport.pending).toEqual([]);
  expect((await readFile(syncedPath)).equals(Buffer.from(imageBytes))).toBe(true);
});

it("an executable script and a symlink in a plan's folder sync to a second clone as they are", async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const plan = await first.runJson<ShownInstruction>([
    'new',
    'plan',
    'Script plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const folder = folderOf(first.storePath, plan.id);
  const scriptPath = join(folder, 'run.sh');
  const linkPath = join(folder, 'latest.md');

  await ageFile(plan.path);
  await mkdir(folder, { recursive: true });
  await writeFile(scriptPath, '#!/bin/sh\necho done\n');
  await chmod(scriptPath, 0o755);
  await writeFile(join(folder, 'design.md'), '# Design\n');
  await symlink('design.md', linkPath);

  const firstReport = await first.runJson<SyncReport>(['sync']);
  await second.runChecked(['sync']);

  const syncedScript = join(second.storePath, relative(first.storePath, scriptPath));
  const syncedLink = join(second.storePath, relative(first.storePath, linkPath));

  expect(firstReport.pending).toEqual([]);
  expect((await lstat(syncedScript)).mode & 0o111).not.toBe(0);
  expect((await lstat(syncedLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(syncedLink)).toBe('design.md');
});

it('a claim fetches first and sees a claim made on another clone', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const instruction = await createSettledInstruction(first, 'Contested instruction');

  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await first.runChecked(['claim', instruction.id, '--holder', 'first-agent']);
  await first.runChecked(['sync']);

  const result = await second.run(['claim', instruction.id, '--holder', 'second-agent']);
  const parsed = JSON.parse(result.stdout) as { error: { code: string } };

  expect(result.exitCode).not.toBe(0);
  expect(parsed.error.code).toBe('conflict');
});

it('a claim still succeeds when origin points at a missing path', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const instruction = await createSettledInstruction(fixture, 'Offline instruction');

  await gitOutput(fixture.storePath, [
    'remote',
    'add',
    'origin',
    join(fixture.home, 'missing.git'),
  ]);

  const claimed = await fixture.runJson<ShownInstruction>([
    'claim',
    instruction.id,
    '--holder',
    'agent',
  ]);

  expect(claimed).toMatchObject({ state: 'active', claim: { holder: 'agent' } });
});

const waitForRemoteCommits = async (remotePath: string, minimum: number): Promise<number> => {
  const deadline = Date.now() + 10_000;
  let count = 0;

  while (Date.now() < deadline) {
    const child = Bun.spawn(['git', '-C', remotePath, 'rev-list', '--count', 'main'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });

    const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

    count = exitCode === 0 ? Number(stdout.trim()) : 0;

    if (count >= minimum) {
      return count;
    }

    await Bun.sleep(200);
  }

  return count;
};

it('a burst of writes on a store with a remote reaches the remote with no explicit sync', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);

  const baseline = await waitForRemoteCommits(remotePath, 1);
  const instruction = await createInstructionIn(first, 'Burst instruction');

  for (const text of ['one', 'two', 'three']) {
    await first.runChecked(['log', instruction.id, '--type', 'progress', '--text', text]);
  }

  const count = await waitForRemoteCommits(remotePath, baseline + 1);

  expect(count).toBeGreaterThan(baseline);
});

const writeHandTicket = async (
  fixture: CliFixture,
  fileName: string,
  aged = true,
): Promise<void> => {
  const directory = join(fixture.storePath, 'tickets', 'demo');
  const path = join(directory, fileName);

  const text =
    '---\nkind: instruction\ntitle: By hand\nproject: demo\nblockedBy: []\nstatus: open\n---\n';

  await mkdir(directory, { recursive: true });
  await writeFile(path, text);

  if (aged) {
    await ageFile(path);
  }
};

it('an ID clash found at merge gives the newer ticket a new ID and writes an alias fact', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  await writeHandTicket(first, 'demo-aaaa-first.md');
  await writeHandTicket(second, 'demo-aaaa-second.md');

  await first.runChecked(['sync']);

  const report = await second.runJson<AliasSyncReport>(['sync']);
  const listing = await second.runJson<{ tickets: { id: string }[] }>(['ls', '--project', 'demo']);
  const ids = listing.tickets.map((ticket) => ticket.id);
  const alias = report.aliases[0];

  expect(report.aliases).toHaveLength(1);
  expect(alias?.from).toBe('demo-aaaa');
  expect(alias?.to).not.toBe('demo-aaaa');
  expect(alias?.path).toContain(`${alias?.to}-second.md`);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  expect(existsSync(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-first.md'))).toBe(true);
  expect(existsSync(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'))).toBe(false);

  const facts = await readAllFacts(second);

  expect(facts).toContain('"kind":"alias"');
  expect(facts).toContain('"from":"demo-aaaa"');
  expect(facts).toContain(`"ticket":"${alias?.to}"`);
  expect(await gitOutput(second.storePath, ['status', '--porcelain'])).toBe('');
});

it('an ID clash after a sync merge moves the folder to the new ID', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  await writeHandTicket(first, 'demo-aaaa-first.md');
  await writeHandTicket(second, 'demo-aaaa-second.md');

  const oldFolder = folderOf(second.storePath, 'demo-aaaa');

  await mkdir(oldFolder, { recursive: true });
  await writeFile(join(oldFolder, 'design.md'), '# Design\n');

  await first.runChecked(['sync']);

  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The sync should report one alias.');

  expect(alias.from).toBe('demo-aaaa');
  expect(existsSync(join(folderOf(second.storePath, alias.to), 'design.md'))).toBe(true);
  expect(existsSync(oldFolder)).toBe(false);

  const facts = await readAllFacts(second);

  expect(facts).toContain('"kind":"alias"');
  expect(facts).toContain('"from":"demo-aaaa"');
  expect(await gitOutput(second.storePath, ['status', '--porcelain'])).toBe('');
});

it('an ID clash keeps an executable folder file executable at the new path', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  await writeHandTicket(first, 'demo-aaaa-first.md');
  await first.runChecked(['sync']);

  await writeHandTicket(second, 'demo-aaaa-second.md');

  const oldFolder = folderOf(second.storePath, 'demo-aaaa');
  const scriptPath = join(oldFolder, 'run.sh');

  await mkdir(oldFolder, { recursive: true });
  await writeFile(scriptPath, '#!/bin/sh\necho done\n');
  await chmod(scriptPath, 0o755);

  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The sync should report one alias.');

  const movedScript = join(folderOf(second.storePath, alias.to), 'run.sh');
  const movedPath = relative(second.storePath, movedScript);

  expect((await lstat(movedScript)).mode & 0o111).not.toBe(0);

  expect(await gitOutput(second.storePath, ['ls-tree', 'HEAD', '--', movedPath])).toMatch(
    /^100755 blob /,
  );
});

const remoteTree = (remotePath: string): Promise<string> =>
  gitOutput(remotePath, ['ls-tree', '-r', '--name-only', 'main']);

const waitForRemoteFile = async (remotePath: string, relativePath: string): Promise<boolean> => {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const tree = await remoteTree(remotePath).catch(() => '');

    if (tree.includes(relativePath)) {
      return true;
    }

    await Bun.sleep(200);
  }

  return false;
};

it('a ticket written just before the background sync reaches the remote with no further write', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await createInstructionIn(first, 'Early instruction');
  await Bun.sleep(2200);

  const late = await createInstructionIn(first, 'Late instruction');
  const lateRelative = relative(first.storePath, late.path);

  expect(await waitForRemoteFile(remotePath, lateRelative)).toBe(true);
}, 40_000);

it('init renames a master branch to main, and a following sync pushes to the remote main', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init']);
  await gitOutput(first.storePath, ['branch', '-m', 'master']);
  await gitOutput(first.storePath, ['remote', 'add', 'origin', remotePath]);
  await first.runChecked(['init']);

  const branch = await gitOutput(first.storePath, ['branch', '--show-current']);
  const report = await first.runJson<SyncReport>(['sync']);

  expect(branch.trim()).toBe('main');
  expect(report.pushed).toBe(true);
  expect(await remoteTree(remotePath)).toContain('tikk.json');
});

it('an uncommitted ticket that clashes with a committed one gets the new ID', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  await writeHandTicket(first, 'demo-aaaa-old.md');
  await first.runChecked(['sync']);
  await writeHandTicket(second, 'demo-aaaa-new.md', false);

  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];
  const directory = join(second.storePath, 'tickets', 'demo');

  expect(report.aliases).toHaveLength(1);
  expect(alias?.from).toBe('demo-aaaa');
  expect(alias?.path).toContain(`${alias?.to}-new.md`);
  expect(existsSync(join(directory, 'demo-aaaa-old.md'))).toBe(true);
  expect(existsSync(join(directory, 'demo-aaaa-new.md'))).toBe(false);
  expect(existsSync(join(directory, `${alias?.to}-new.md`))).toBe(true);
});

it('the next sync commits changes a failed commit left staged', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);
  await createSettledInstruction(fixture, 'Staged instruction');

  const hook = join(fixture.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);

  const failed = await fixture.run(['sync']);

  expect(failed.exitCode).not.toBe(0);
  expect(await gitOutput(fixture.storePath, ['diff', '--cached', '--name-only'])).not.toBe('');

  await rm(hook);

  const report = await fixture.runJson<SyncReport>(['sync']);

  expect(report.committed).toBe(true);
  expect(await gitOutput(fixture.storePath, ['status', '--porcelain'])).toBe('');
});

it('a second init --remote after an offline one joins the histories and pushes', async () => {
  const { first, second } = clonePair();
  const lateRemote = join(first.home, 'late.git');

  await first.runChecked(['init']);

  const firstInstruction = await createSettledInstruction(first, 'First instruction');

  await first.runChecked(['sync']);
  await first.runChecked(['init', '--remote', lateRemote]);
  await gitOutput(first.home, ['init', '--bare', '--initial-branch=main', lateRemote]);
  await second.runChecked(['init', '--remote', lateRemote]);

  const secondInstruction = await createSettledInstruction(second, 'Second instruction');

  await second.runChecked(['sync']);
  await first.runChecked(['init', '--remote', lateRemote]);

  const tree = await remoteTree(lateRemote);

  expect(tree).toContain(relative(first.storePath, firstInstruction.path));
  expect(tree).toContain(relative(second.storePath, secondInstruction.path));

  const merged = await gitOutput(first.storePath, ['merge-base', 'HEAD', 'origin/main']);

  expect(merged.trim()).not.toBe('');
});

it('a staged ticket that is fresh or does not parse stays out of the commit and is pending', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const settled = await createSettledInstruction(fixture, 'Settled instruction');
  const fresh = await createInstructionIn(fixture, 'Fresh instruction');
  const brokenCopy = join(dirname(settled.path), 'broken.md');

  await writeFile(brokenCopy, 'no front matter here\n');
  await ageFile(brokenCopy);

  const freshPath = relative(fixture.storePath, fresh.path);
  const brokenRelative = relative(fixture.storePath, brokenCopy);

  await gitOutput(fixture.storePath, ['add', '--', freshPath, brokenRelative]);

  const report = await fixture.runJson<SyncReport>(['sync']);
  const tracked = await gitOutput(fixture.storePath, ['ls-tree', '-r', '--name-only', 'HEAD']);

  expect(report.committed).toBe(true);
  expect(report.pending.toSorted()).toEqual([brokenRelative, freshPath].toSorted());
  expect(tracked).toContain(relative(fixture.storePath, settled.path));
  expect(tracked).not.toContain(freshPath);
  expect(tracked).not.toContain(brokenRelative);
});

const syncClashWithNewTicket = async (aged: boolean) => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);
  await writeHandTicket(first, 'demo-aaaa-old.md');
  await first.runChecked(['sync']);
  await writeHandTicket(second, 'demo-aaaa-new.md', aged);

  const report = await second.runJson<AliasSyncReport>(['sync']);

  return { report, remotePath, alias: report.aliases[0] };
};

it('an unsettled ticket renamed by a clash is pending under its new path', async () => {
  const { report, remotePath, alias } = await syncClashWithNewTicket(false);

  expect(alias?.path).toBeDefined();
  expect(report.pending).toEqual([alias?.path ?? '']);
  expect(await remoteTree(remotePath)).not.toContain('-new.md');
});

it('a merge that fails for another reason than a conflict is aborted and not pushed', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);
  await createSettledInstruction(first, 'First instruction');
  await first.runChecked(['sync']);
  await createSettledInstruction(second, 'Second instruction');

  const hook = join(second.storePath, '.git', 'hooks', 'pre-merge-commit');

  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\necho hook refused >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const before = await gitOutput(remotePath, ['rev-parse', 'main']);
  const result = await second.run(['sync']);
  const parsed = JSON.parse(result.stdout) as { error: { code: string } };

  expect(result.exitCode).not.toBe(0);
  expect(parsed.error.code).toBe('storeError');
  expect(existsSync(join(second.storePath, '.git', 'MERGE_HEAD'))).toBe(false);
  expect(await gitOutput(remotePath, ['rev-parse', 'main'])).toBe(before);
});

it('a clash that renames a tracked ticket with a pending edit reports the new path as pending', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);
  await writeHandTicket(first, 'demo-aaaa-a.md');
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeHandTicket(second, 'demo-aaaa-b.md');
  await gitOutput(second.storePath, ['add', '-A']);

  await gitOutput(second.storePath, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'local',
  ]);

  const path = join(second.storePath, 'tickets', 'demo', 'demo-aaaa-b.md');

  await writeFile(path, `${await readFile(path, 'utf8')}\nedited\n`);

  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  expect(alias?.path).toContain('-b.md');
  expect(report.pending).toEqual([alias?.path ?? '']);
});

it('the next sync commits a ticket deletion that a failed commit left staged', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);

  const instruction = await createSettledInstruction(first, 'Doomed instruction');
  const relativePath = relative(first.storePath, instruction.path);

  await first.runChecked(['sync']);
  await rm(instruction.path);

  const hook = join(first.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);

  const failed = await first.run(['sync']);

  expect(failed.exitCode).not.toBe(0);

  await rm(hook);
  await first.runChecked(['sync']);

  expect(await remoteTree(remotePath)).not.toContain(relativePath);
});

it('a failed clash commit and a bad edit to the clashing ticket lose no ticket on the remote', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);
  await writeHandTicket(first, 'demo-aaaa-a.md');
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeHandTicket(second, 'demo-aaaa-b.md');

  const hook = join(second.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });

  await writeFile(
    hook,
    '#!/bin/sh\ngit diff --cached --name-only | grep -q "^facts/" && exit 1\nexit 0\n',
  );

  await chmod(hook, 0o755);

  const failed = await second.run(['sync']);

  expect(failed.exitCode).not.toBe(0);
  await rm(hook);

  const directory = join(second.storePath, 'tickets', 'demo');

  expect(await readdir(directory)).toContain('demo-aaaa-b.md');
  await writeFile(join(directory, 'demo-aaaa-b.md'), 'no front matter here\n');

  const report = await second.runJson<SyncReport>(['sync']);
  const renamed = (await readdir(directory)).find((name) => /^demo-(?!aaaa).*-b\.md$/.test(name));
  const renamedRelative = `tickets/demo/${renamed ?? ''}`;
  const tree = await remoteTree(remotePath);
  const content = await gitOutput(remotePath, ['show', `main:${renamedRelative}`]);

  expect(report.pending).toEqual([renamedRelative]);
  expect(tree).toContain('tickets/demo/demo-aaaa-a.md');
  expect(tree).toContain(renamedRelative);
  expect(content).toContain('title: By hand');
});

it('tikk sync alone pushes a store on master to the remote main', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await gitOutput(first.storePath, ['branch', '-m', 'master']);
  await createSettledInstruction(first, 'Master instruction');

  const report = await first.runJson<SyncReport>(['sync']);
  const branch = await gitOutput(first.storePath, ['branch', '--show-current']);
  const tree = await remoteTree(remotePath);

  expect(branch.trim()).toBe('main');
  expect(report.pushed).toBe(true);
  expect(tree).toContain('tickets/personal/');
});

it('a failed clash commit and a sync within two seconds keep both tickets and one alias fact', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const offline = join(first.home, 'offline.git');

  await gitOutput(first.storePath, ['remote', 'set-url', 'origin', offline]);
  await writeHandTicket(first, 'demo-aaaa-older.md');
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeHandTicket(second, 'demo-aaaa-newer.md');
  await second.runChecked(['sync']);
  await gitOutput(first.storePath, ['remote', 'set-url', 'origin', remotePath]);

  const hook = join(first.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });

  await writeFile(
    hook,
    '#!/bin/sh\ngit diff --cached --name-only | grep -q "^facts/" && exit 1\nexit 0\n',
  );

  await chmod(hook, 0o755);

  const failed = await first.run(['sync']);

  expect(failed.exitCode).not.toBe(0);
  await rm(hook);
  await first.runChecked(['sync']);

  const tree = await remoteTree(remotePath);
  const facts = await readAllFacts(first);
  const aliasLines = facts.split('\n').filter((line) => line.includes('"kind":"alias"'));

  expect(tree).toContain('tickets/demo/demo-aaaa-older.md');
  expect(tree.match(/-newer\.md/g)).toHaveLength(1);
  expect(tree).not.toContain('demo-aaaa-newer.md');
  expect(aliasLines).toHaveLength(1);

  const adding = (
    await gitOutput(first.storePath, ['log', '--format=%H', '-S"kind":"alias"', '--', 'facts'])
  )
    .trim()
    .split('\n');

  expect(adding).toHaveLength(1);

  expect(
    await gitOutput(first.storePath, ['show', '--name-status', '--format=', adding[0] ?? '']),
  ).toContain('-newer.md');
});

it('a sync after a failed commit commits an edit, a deletion, and a new ticket', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);

  const edited = await createSettledInstruction(first, 'Edited instruction');
  const deleted = await createSettledInstruction(first, 'Deleted instruction');

  await first.runChecked(['sync']);

  const editedText = await readFile(edited.path, 'utf8');

  await writeFile(edited.path, `${editedText}\nAn edit.\n`);
  await ageFile(edited.path);
  await rm(deleted.path);

  const created = await createSettledInstruction(first, 'New instruction');
  const hook = join(first.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);

  const failed = await first.run(['sync']);

  expect(failed.exitCode).not.toBe(0);
  await rm(hook);
  await first.runChecked(['sync']);

  const tree = await remoteTree(remotePath);
  const editedRelative = relative(first.storePath, edited.path);
  const shown = await gitOutput(remotePath, ['show', `main:${editedRelative}`]);

  expect(tree).toContain(relative(first.storePath, created.path));
  expect(tree).not.toContain(relative(first.storePath, deleted.path));
  expect(shown).toContain('An edit.');
});

it('tikk sync commits and pushes a store that has no commit yet', async () => {
  const { first, remotePath } = clonePair();

  await mkdir(first.storePath, { recursive: true });
  await gitOutput(first.storePath, ['init', '--quiet']);
  await gitOutput(first.storePath, ['remote', 'add', 'origin', remotePath]);
  await writeFile(join(first.storePath, 'tikk.json'), '{"version":1}\n');
  await writeHandTicket(first, 'demo-aaaa-old.md');

  const report = await first.runJson<SyncReport>(['sync']);
  const tree = await remoteTree(remotePath);

  expect(report.committed).toBe(true);
  expect(report.pushed).toBe(true);
  expect(tree).toContain('tickets/demo/demo-aaaa-old.md');
});

const countProcesses = async (marker: string): Promise<number> => {
  const child = Bun.spawn(['pgrep', '-f', marker], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout] = await Promise.all([child.stdout.text(), child.exited]);

  return stdout.split('\n').filter((line) => line !== '').length;
};

it('a sync against a remote whose transport hangs gives up and kills the hanging process', async () => {
  const fixture = singleFixture();
  const marker = `${process.pid}${Date.now() % 100000}`;
  const hang = join(fixture.home, 'hang.sh');
  const previous = process.env['GIT_SSH_COMMAND'];

  await writeFile(hang, `#!/bin/sh\nexec sleep 3${marker}\n`);
  await chmod(hang, 0o755);
  await fixture.runChecked(['init']);
  await gitOutput(fixture.storePath, ['remote', 'add', 'origin', 'ssh://hang.invalid/repo.git']);
  process.env['GIT_SSH_COMMAND'] = hang;

  const started = Date.now();

  try {
    const report = await fixture.runJson<SyncReport>(['sync']);

    expect(report.fetched).toBe(false);
    expect(Date.now() - started).toBeLessThan(25_000);
  } finally {
    if (previous === undefined) {
      delete process.env['GIT_SSH_COMMAND'];
    } else {
      process.env['GIT_SSH_COMMAND'] = previous;
    }
  }

  await Bun.sleep(500);
  expect(await countProcesses(`sleep 3${marker}`)).toBe(0);
}, 40_000);

it('a sync reports merged false when the fetch failed', async () => {
  const { first, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await first.runChecked(['sync']);
  await rename(remotePath, `${remotePath}.gone`);

  const report = await first.runJson<SyncReport>(['sync']);

  await rename(`${remotePath}.gone`, remotePath);

  expect(report.fetched).toBe(false);
  expect(report.merged).toBe(false);
});

const makeBareRemote = async (path: string, rejectPushes: boolean): Promise<void> => {
  await gitOutput(dirname(path), ['init', '--quiet', '--bare', '--initial-branch=main', path]);

  if (rejectPushes) {
    const hook = join(path, 'hooks', 'pre-receive');

    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
  }
};

it('init --remote reports pushed false when the remote rejects the first push on an empty folder', async () => {
  const fixture = singleFixture();
  const remote = join(fixture.home, 'reject.git');

  await makeBareRemote(remote, true);

  const report = await fixture.runJson<InitReport>(['init', '--remote', remote]);

  expect(report.pushed).toBe(false);
  expect(report.remote).toBe(remote);
});

it('init --remote reports pushed false when the remote rejects the push for an existing store', async () => {
  const fixture = singleFixture();
  const remote = join(fixture.home, 'reject.git');

  await makeBareRemote(remote, true);
  await fixture.runChecked(['init']);

  const report = await fixture.runJson<InitReport>(['init', '--remote', remote]);

  expect(report.pushed).toBe(false);
});

it('init --remote reports pushed true when the remote takes the push', async () => {
  const fixture = singleFixture();
  const remote = join(fixture.home, 'accept.git');

  await makeBareRemote(remote, false);

  const report = await fixture.runJson<InitReport>(['init', '--remote', remote]);

  expect(report.pushed).toBe(true);
});

it('init --remote refuses a clone that is not a tikk store and leaves the folder free', async () => {
  const fixture = singleFixture();
  const other = join(fixture.home, 'other.git');
  const seed = join(fixture.home, 'seed');
  const valid = join(fixture.home, 'valid.git');

  await makeBareRemote(other, false);
  await mkdir(seed, { recursive: true });
  await gitOutput(seed, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(seed, 'README.md'), 'not a store\n');
  await gitOutput(seed, ['add', '.']);

  await gitOutput(seed, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'x',
  ]);

  await gitOutput(seed, ['push', '--quiet', other, 'main']);
  await makeBareRemote(valid, false);

  const failed = await fixture.run(['init', '--remote', other]);

  expect(failed.exitCode).not.toBe(0);
  expect(existsSync(fixture.storePath) ? await readdir(fixture.storePath) : []).toEqual([]);

  const report = await fixture.runJson<InitReport>(['init', '--remote', valid]);

  expect(report.created).toBe(true);
});

const seedNonStoreRemote = async (home: string, name: string): Promise<string> => {
  const remote = join(home, name);
  const seed = join(home, `${name}-seed`);

  await makeBareRemote(remote, false);
  await mkdir(seed, { recursive: true });
  await gitOutput(seed, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(seed, 'README.md'), 'not a store\n');
  await gitOutput(seed, ['add', '.']);

  await gitOutput(seed, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '--quiet',
    '-m',
    'x',
  ]);

  await gitOutput(seed, ['push', '--quiet', remote, 'main']);

  return remote;
};

it('a failed clone keeps an empty store folder and leaves no temporary folder', async () => {
  const fixture = singleFixture();
  const other = await seedNonStoreRemote(fixture.home, 'other.git');

  await mkdir(fixture.storePath, { recursive: true });

  const failed = await fixture.run(['init', '--remote', other]);

  expect(failed.exitCode).not.toBe(0);
  expect(existsSync(fixture.storePath)).toBe(true);
  expect(await readdir(fixture.storePath)).toEqual([]);
  expect((await readdir(fixture.home)).filter((name) => name.startsWith('store.'))).toEqual([]);
});

it('a file written into the store folder during the clone survives, and init fails', async () => {
  const fixture = singleFixture();
  const { remotePath } = clonePair();
  const template = join(fixture.home, 'template');
  const previous = process.env['GIT_TEMPLATE_DIR'];

  await fixture.runChecked(['init', '--remote', remotePath]);
  await rm(fixture.storePath, { recursive: true, force: true });
  await mkdir(join(template, 'hooks'), { recursive: true });
  await mkdir(fixture.storePath, { recursive: true });

  const hook = join(template, 'hooks', 'post-checkout');

  await writeFile(hook, `#!/bin/sh\necho mine > '${join(fixture.storePath, 'late.txt')}'\n`);
  await chmod(hook, 0o755);
  process.env['GIT_TEMPLATE_DIR'] = template;

  try {
    const failed = await fixture.run(['init', '--remote', remotePath]);

    expect(failed.exitCode).not.toBe(0);
  } finally {
    if (previous === undefined) {
      delete process.env['GIT_TEMPLATE_DIR'];
    } else {
      process.env['GIT_TEMPLATE_DIR'] = previous;
    }
  }

  expect(await readFile(join(fixture.storePath, 'late.txt'), 'utf8')).toBe('mine\n');
  expect((await readdir(fixture.home)).filter((name) => name.startsWith('store.'))).toEqual([]);
});
