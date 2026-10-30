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

import { openCache } from '../src/cache/cache.ts';
import { parseFactLine } from '../src/fact/fact.ts';
import type { Fact } from '../src/fact/fact.ts';
import { invariant } from '../src/invariant.ts';
import { createOpenSession } from '../src/sessionEffects.ts';
import { nodeTicketFiles } from '../src/store/storeHarness.ts';
import { ticketFolderPath } from '../src/store/storePaths.ts';
import type { SyncDelays } from '../src/sync/sync.ts';
import { parseProjectName, parseTicketId } from '../src/ticket/ticket.ts';
import { createCliFixture, createCloneFixtures, waitForBackgroundSync } from './cliFixture.ts';
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

const syncDelays: SyncDelays = { debounceMilliseconds: 1000, settleMilliseconds: 1000 };

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
  clones = await createCloneFixtures('tikk-sync-', syncDelays);
  single = await createCliFixture('tikk-sync-single-', { syncDelays });
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

it('a folder file that .git/info/exclude matches syncs, and an ignored file outside ticket folders does not', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const plan = await first.runJson<ShownInstruction>([
    'new',
    'plan',
    'Ignored plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const reportPath = join(folderOf(first.storePath, plan.id), 'reports', 'run.log');
  const outsidePath = join(first.storePath, 'logs', 'scratch.txt');
  const excludePath = join(first.storePath, '.git', 'info', 'exclude');

  await ageFile(plan.path);
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, 'run.log\nscratch.txt\n');
  await writeFile(reportPath, 'done\n');
  await mkdir(dirname(outsidePath), { recursive: true });
  await writeFile(outsidePath, 'scratch\n');

  const firstReport = await first.runJson<SyncReport>(['sync']);
  await second.runChecked(['sync']);

  const syncedReport = join(second.storePath, relative(first.storePath, reportPath));
  const syncedOutside = join(second.storePath, relative(first.storePath, outsidePath));

  expect(firstReport.pending).toEqual([]);
  expect(await readFile(syncedReport, 'utf8')).toBe('done\n');
  expect(existsSync(syncedOutside)).toBe(false);
});

it("a dangling symlink in a plan's folder syncs to a second clone as a symlink", async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const plan = await first.runJson<ShownInstruction>([
    'new',
    'plan',
    'Dangling plan',
    '--project',
    'demo',
    '--status',
    'draft',
  ]);

  const folder = folderOf(first.storePath, plan.id);
  const linkPath = join(folder, 'latest.md');

  await ageFile(plan.path);
  await mkdir(folder, { recursive: true });
  await symlink('missing.md', linkPath);

  const firstReport = await first.runJson<SyncReport>(['sync']);
  await second.runChecked(['sync']);

  const syncedLink = join(second.storePath, relative(first.storePath, linkPath));

  expect(firstReport.pending).toEqual([]);
  expect((await lstat(syncedLink)).isSymbolicLink()).toBe(true);
  expect(await readlink(syncedLink)).toBe('missing.md');
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

const removeOrigin = (fixture: CliFixture): Promise<string> =>
  gitOutput(fixture.storePath, ['remote', 'remove', 'origin']);

const addOrigin = (fixture: CliFixture, remotePath: string): Promise<string> =>
  gitOutput(fixture.storePath, ['remote', 'add', 'origin', remotePath]);

const writeClashTicket = async (
  fixture: CliFixture,
  id: string,
  slug: string,
  parentId: string,
  aged = true,
  kind = 'instruction',
): Promise<void> => {
  const directory = join(fixture.storePath, 'tickets', 'demo');
  const path = join(directory, `${id}-${slug}.md`);
  const text = `---\nkind: ${kind}\ntitle: ${slug}\nproject: demo\nparent: ${parentId}\nblockedBy: []\nstatus: open\n---\n`;

  await mkdir(directory, { recursive: true });
  await writeFile(path, text);

  if (aged) {
    await ageFile(path);
  }
};

const touchFile = async (path: string): Promise<void> => {
  const now = new Date();

  await utimes(path, now, now);
};

const settleWaitMilliseconds = syncDelays.settleMilliseconds + 100;

const commitOn = async (root: string, date: string): Promise<void> => {
  const child = Bun.spawn(
    [
      'git',
      '-C',
      root,
      '-c',
      'user.name=tikk',
      '-c',
      'user.email=tikk@example.test',
      'commit',
      '--quiet',
      '-m',
      'Offline ticket',
    ],
    {
      env: { ...Bun.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );

  const exitCode = await child.exited;

  invariant(exitCode === 0, `git commit exited with ${exitCode}.`);
};

const aliasLinesOf = (facts: string): string[] =>
  facts.split('\n').filter((line) => line.includes('"kind":"alias"'));

const runJsonError = (stdout: string): string | undefined => {
  const parsed = JSON.parse(stdout) as { error?: { code?: string } };

  return parsed.error?.code;
};

const gitShowOrEmpty = async (root: string, object: string): Promise<string> => {
  const child = Bun.spawn(['git', '-C', root, 'show', object], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  const [stdout, exitCode] = await Promise.all([child.stdout.text(), child.exited]);

  return exitCode === 0 ? stdout : '';
};

const readFactFiles = async (fixture: CliFixture): Promise<Map<string, string>> => {
  const factsDirectory = join(fixture.storePath, 'facts');
  const entries = await readdir(factsDirectory, { recursive: true });
  const files = entries.filter((entry) => entry.endsWith('.jsonl'));

  const texts = await Promise.all(
    files.map(async (file) => [file, await readFile(join(factsDirectory, file), 'utf8')] as const),
  );

  return new Map(texts);
};

const kindOf = (line: string): string => {
  const parsed = parseFactLine(line);

  invariant(parsed.ok, 'The appended line should be a fact.');

  return parsed.value.kind;
};

const expectOnlyAliasAppended = (before: Map<string, string>, after: Map<string, string>): void => {
  const appended = [...before].flatMap(([file, text]) => {
    const current = after.get(file) ?? '';

    expect(current.startsWith(text)).toBe(true);

    return current
      .slice(text.length)
      .split('\n')
      .filter((line) => line !== '');
  });

  expect(appended.map(kindOf)).toEqual(['alias']);
};

const listTicketFacts = (fixture: CliFixture, id: string): Fact[] => {
  const ticketId = parseTicketId(id);
  const opened = openCache(join(fixture.home, '.cache', 'tikk', 'index.db'));

  invariant(ticketId.ok && opened.ok, 'The cache and the ticket ID should open.');

  const listed = opened.value.listFacts([ticketId.value]);

  opened.value[Symbol.dispose]();
  invariant(listed.ok, 'The cached facts should read.');

  return listed.value;
};

const logTexts = (facts: Fact[]): string[] =>
  facts.flatMap((fact) => (fact.kind === 'log' ? [fact.text] : []));

const dropCache = async (fixture: CliFixture): Promise<void> => {
  await waitForBackgroundSync(fixture.storePath);
  await rm(join(fixture.home, '.cache', 'tikk'), { recursive: true, force: true });
};

it('an ID clash keeps pre-clash facts with the renamed ticket on both clones', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['sync']);
  await Bun.sleep(1100);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
  await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

  const question = await second.runJson<{ item: string }>([
    'log',
    'demo-aaaa',
    '--type',
    'question',
    '--text',
    'B question before clash',
  ]);

  await second.runChecked(['pass-up', 'demo-aaaa', '--item', question.item]);
  await second.runChecked(['sync']);

  const before = await readFactFiles(second);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);
  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The clash should write one alias.');
  expect(alias.from).toBe('demo-aaaa');
  expect(alias.path).toContain('-second.md');

  await first.runChecked(['sync']);
  expectOnlyAliasAppended(before, await readFactFiles(second));

  const expectBClashFacts = async (fixture: CliFixture): Promise<void> => {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);
    const old = await fixture.runJson<ShownInstruction>(['show', 'demo-aaaa']);
    const ready = await fixture.runJson<{ candidates: { id: string }[] }>(['ready']);
    const needs = await fixture.runJson<{ items: { id: string; reason: string }[] }>(['needs']);

    expect(renamed.claim?.holder).toBe('second-agent');
    expect(old.claim).toBeNull();
    expect(ready.candidates.map((candidate) => candidate.id)).toContain('demo-aaaa');
    expect(ready.candidates.map((candidate) => candidate.id)).not.toContain(alias.to);
    expect(needs.items.map((item) => [item.id, item.reason])).toEqual([[alias.to, 'question']]);

    const renamedFacts = listTicketFacts(fixture, alias.to);

    expect(renamedFacts.filter((fact) => fact.kind !== 'alias').map((fact) => fact.kind)).toEqual([
      'claim',
      'log',
      'log',
      'passUp',
    ]);

    expect(logTexts(renamedFacts)).toEqual(['B progress before clash', 'B question before clash']);
    expect(listTicketFacts(fixture, 'demo-aaaa')).toEqual([]);
  };

  for (const fixture of [second, first]) {
    await expectBClashFacts(fixture);
  }

  for (const fixture of [second, first]) {
    await dropCache(fixture);
    await expectBClashFacts(fixture);
  }
});

it("an ID clash that renames the other clone's ticket moves that clone's pre-clash facts with it", async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
  await second.runChecked(['sync']);
  await Bun.sleep(1100);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['claim', 'demo-aaaa', '--holder', 'first-agent']);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A progress before clash',
  ]);

  await first.runChecked(['sync']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

  await second.runChecked(['sync']);

  const before = await readFactFiles(second);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);
  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The clash should write one alias.');
  expect(alias.from).toBe('demo-aaaa');
  expect(alias.path).toContain('-first.md');

  await first.runChecked(['sync']);
  expectOnlyAliasAppended(before, await readFactFiles(second));

  const expectAClashFacts = async (fixture: CliFixture): Promise<void> => {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);
    const old = await fixture.runJson<ShownInstruction>(['show', 'demo-aaaa']);
    const ready = await fixture.runJson<{ candidates: { id: string }[] }>(['ready']);

    expect(renamed.claim?.holder).toBe('first-agent');
    expect(old.claim).toBeNull();
    expect(ready.candidates.map((candidate) => candidate.id)).toContain('demo-aaaa');
    expect(ready.candidates.map((candidate) => candidate.id)).not.toContain(alias.to);

    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual(['A progress before clash']);
    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual(['B progress before clash']);
  };

  for (const fixture of [second, first]) {
    await expectAClashFacts(fixture);
  }

  for (const fixture of [second, first]) {
    await dropCache(fixture);
    await expectAClashFacts(fixture);
  }
});

it('an ID clash keeps pre-clash facts with a renamed ticket that is not committed yet', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['sync']);

  const secondTicketPath = join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md');

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);
  await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);
  await touchFile(secondTicketPath);

  const before = await readFactFiles(second);
  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The clash should write one alias.');
  expect(alias.from).toBe('demo-aaaa');
  expect(alias.path).toContain('-second.md');

  await Bun.sleep(settleWaitMilliseconds);
  await second.runChecked(['sync']);
  await first.runChecked(['sync']);
  expectOnlyAliasAppended(before, await readFactFiles(second));

  for (const fixture of [second, first]) {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);
    const old = await fixture.runJson<ShownInstruction>(['show', 'demo-aaaa']);

    expect(renamed.claim?.holder).toBe('second-agent');
    expect(old.claim).toBeNull();
    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual(['B progress before clash']);
    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([]);
  }
});

it('a second ID clash keeps the renamed ticket claim and log with it, and the clone that kept the intermediate ID shows none', async () => {
  const { first, second, remotePath } = clonePair();

  const third = await createCliFixture('tikk-sync-third-', {
    machine: 'third',
    remotePath,
    syncDelays,
  });

  try {
    await first.runChecked(['init', '--remote', remotePath]);
    await second.runChecked(['init', '--remote', remotePath]);

    const parent = await first.runJson<ShownInstruction>([
      'new',
      'slice',
      'Shared parent',
      '--status',
      'draft',
    ]);

    await ageFile(parent.path);
    await first.runChecked(['sync']);
    await second.runChecked(['sync']);
    await third.runChecked(['init', '--remote', remotePath]);
    await removeOrigin(first);
    await removeOrigin(second);
    await removeOrigin(third);

    await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
    await first.runChecked(['sync']);
    await Bun.sleep(1100);

    await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
    await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

    await second.runChecked([
      'log',
      'demo-aaaa',
      '--type',
      'progress',
      '--text',
      'B progress before clash',
    ]);

    await second.runChecked(['sync']);

    await addOrigin(first, remotePath);
    await addOrigin(second, remotePath);
    await first.runChecked(['sync']);
    const firstReport = await second.runJson<AliasSyncReport>(['sync']);
    const firstAlias = firstReport.aliases[0];

    invariant(firstAlias !== undefined, 'The first clash should write one alias.');

    await writeClashTicket(third, firstAlias.to, 'third', parent.id);
    await gitOutput(third.storePath, ['add', '--', 'tickets']);
    await commitOn(third.storePath, '2026-10-01T10:00:00Z');
    await addOrigin(third, remotePath);

    const secondReport = await third.runJson<AliasSyncReport>(['sync']);
    const secondAlias = secondReport.aliases[0];

    invariant(secondAlias !== undefined, 'The second clash should write one alias.');
    expect(secondAlias.from).toBe(firstAlias.to);

    await first.runChecked(['sync']);

    for (const fixture of [third, first]) {
      const renamed = await fixture.runJson<ShownInstruction>(['show', secondAlias.to]);
      const kept = await fixture.runJson<ShownInstruction>(['show', firstAlias.to]);

      expect(renamed.claim?.holder).toBe('second-agent');
      expect(kept.claim).toBeNull();

      expect(logTexts(listTicketFacts(fixture, secondAlias.to))).toEqual([
        'B progress before clash',
      ]);

      expect(logTexts(listTicketFacts(fixture, firstAlias.to))).toEqual([]);
    }
  } finally {
    await third.cleanup();
  }
});

const aliasTicketOf = (facts: string): string => {
  const aliasLine = facts.split('\n').find((line) => line.includes('"kind":"alias"'));
  const parsed = parseFactLine(aliasLine ?? '');

  invariant(parsed.ok && parsed.value.kind === 'alias', 'The facts should hold one alias.');

  return parsed.value.ticket;
};

const failNextTreeRead = async (fixture: CliFixture, fileName: string): Promise<string> => {
  const folder = join(fixture.home, 'failing-git');
  const marker = join(fixture.home, 'fail-next-ls-tree');
  const realGit = Bun.which('git');

  invariant(realGit !== null, 'git should be on PATH.');

  await mkdir(folder, { recursive: true });

  await writeFile(
    join(folder, 'git'),
    `#!/bin/sh\ncase "$*" in\n  *ls-tree*${fileName}*)\n    if [ -e "${marker}" ]; then\n      rm -f "${marker}"\n      echo "injected history failure" >&2\n      exit 1\n    fi\n    ;;\nesac\nexec "${realGit}" "$@"\n`,
  );

  await chmod(join(folder, 'git'), 0o755);
  await writeFile(marker, '');

  return `${folder}:${Bun.env.PATH ?? ''}`;
};

it('a failed clash commit leaves pre-clash facts on the old ID until the retry renames the ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  const offline = join(first.home, 'offline.git');

  await gitOutput(first.storePath, ['remote', 'set-url', 'origin', offline]);
  await writeClashTicket(first, 'demo-aaaa', 'older', parent.id);
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeClashTicket(second, 'demo-aaaa', 'newer', parent.id);
  await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

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

  const aliasTicket = aliasTicketOf(await readAllFacts(first));

  await first.runChecked(['ls']);

  expect(logTexts(listTicketFacts(first, 'demo-aaaa'))).toEqual(['B progress before clash']);
  expect(logTexts(listTicketFacts(first, aliasTicket))).toEqual([]);

  await rm(hook);
  await first.runChecked(['sync']);
  await first.runChecked(['ls']);

  expect(logTexts(listTicketFacts(first, aliasTicket))).toEqual(['B progress before clash']);
  expect(logTexts(listTicketFacts(first, 'demo-aaaa'))).toEqual([]);
});

it('a clash retry after a fact-history read fails keeps the pre-clash facts with the renamed ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['sync']);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);
  await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);

  const failingPath = await failNextTreeRead(second, 'demo-aaaa-second.md');
  const failed = await second.run(['sync'], { path: failingPath });

  expect(existsSync(join(second.home, 'fail-next-ls-tree'))).toBe(false);
  expect(failed.exitCode).not.toBe(0);
  expect(existsSync(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'))).toBe(true);
  expect(aliasLinesOf(await readAllFacts(second))).toEqual([]);

  await Bun.sleep(settleWaitMilliseconds);
  const retry = await second.runJson<AliasSyncReport>(['sync']);
  const alias = retry.aliases[0];

  invariant(alias !== undefined, 'The retry should write one alias.');
  expect(alias.from).toBe('demo-aaaa');

  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);

    expect(renamed.claim?.holder).toBe('second-agent');
    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual(['B progress before clash']);
    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([]);
  }
});

it('a clash retry after a newer merge keeps the pre-clash facts with the renamed ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
  await second.runChecked(['sync']);
  await Bun.sleep(1100);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['claim', 'demo-aaaa', '--holder', 'first-agent']);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A progress before clash',
  ]);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);

  const failingPath = await failNextTreeRead(second, 'demo-aaaa-first.md');
  const failed = await second.run(['sync'], { path: failingPath });

  expect(existsSync(join(second.home, 'fail-next-ls-tree'))).toBe(false);
  expect(failed.exitCode).not.toBe(0);
  expect(aliasLinesOf(await readAllFacts(second))).toEqual([]);
  expect(existsSync(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-first.md'))).toBe(true);

  const advance = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Advance',
    '--status',
    'draft',
  ]);

  await ageFile(advance.path);
  await first.runChecked(['sync']);

  const retry = await second.runJson<AliasSyncReport>(['sync']);
  const alias = retry.aliases[0];

  invariant(alias !== undefined, 'The retry should write one alias.');
  expect(alias.from).toBe('demo-aaaa');
  expect(alias.path).toContain('-first.md');

  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);
    const old = await fixture.runJson<ShownInstruction>(['show', 'demo-aaaa']);

    expect(renamed.claim?.holder).toBe('first-agent');
    expect(old.claim).toBeNull();
    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual(['A progress before clash']);
    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([]);
  }
});

it('a clash retry refuses writes under the shared ID and keeps the pre-clash facts with the renamed ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
  await second.runChecked(['sync']);
  await Bun.sleep(1100);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['claim', 'demo-aaaa', '--holder', 'first-agent']);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A progress before clash',
  ]);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);

  const failingPath = await failNextTreeRead(second, 'demo-aaaa-first.md');
  const failed = await second.run(['sync'], { path: failingPath });

  expect(existsSync(join(second.home, 'fail-next-ls-tree'))).toBe(false);
  expect(failed.exitCode).not.toBe(0);
  expect(aliasLinesOf(await readAllFacts(second))).toEqual([]);

  {
    const refused = await second.run([
      'log',
      'demo-aaaa',
      '--type',
      'progress',
      '--text',
      'Written in the window',
      '--json',
    ]);

    expect(refused.exitCode).not.toBe(0);
    expect(runJsonError(refused.stdout)).toBe('idShared');
  }

  await first.runChecked(['sync']);

  const retry = await second.runJson<AliasSyncReport>(['sync']);
  const alias = retry.aliases[0];

  invariant(alias !== undefined, 'The retry should write one alias.');
  expect(alias.from).toBe('demo-aaaa');
  expect(alias.path).toContain('-first.md');

  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    const renamed = await fixture.runJson<ShownInstruction>(['show', alias.to]);

    expect(renamed.claim?.holder).toBe('first-agent');

    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual(['A progress before clash']);
    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([]);
  }
});

it('a pending renamed ticket keeps its own facts when the other clone merged facts it pushed before the ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B log published before its ticket',
  ]);

  await addOrigin(second, remotePath);
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  await second.runChecked(['sync']);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A log for surviving ticket',
  ]);

  await addOrigin(first, remotePath);
  await first.runChecked(['sync']);

  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The clash should write one alias.');
  expect(alias.from).toBe('demo-aaaa');

  await second.runChecked(['ls']);

  expect(logTexts(listTicketFacts(second, alias.to))).toEqual([
    'B log published before its ticket',
  ]);

  expect(logTexts(listTicketFacts(second, 'demo-aaaa'))).toEqual(['A log for surviving ticket']);

  await Bun.sleep(settleWaitMilliseconds);
  await second.runChecked(['sync']);
  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    await fixture.runChecked(['ls']);

    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual([
      'B log published before its ticket',
    ]);

    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual(['A log for surviving ticket']);
  }
});

it('a fact write refuses a ticket ID that two ticket files share and appends no fact', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const parent = await fixture.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await writeClashTicket(fixture, 'demo-aaaa', 'first', parent.id);
  await writeClashTicket(fixture, 'demo-aaaa', 'second', parent.id);

  const before = await readAllFacts(fixture).catch(() => '');

  const logged = await fixture.run([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'Written under a shared ID',
    '--json',
  ]);

  expect(logged.exitCode).not.toBe(0);
  expect(runJsonError(logged.stdout)).toBe('idShared');
  expect(logged.stdout).toContain('demo-aaaa');
  expect(await readAllFacts(fixture).catch(() => '')).toBe(before);
});

it('a fact write accepts an ID when the other file with it sits in another project folder', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const parent = await fixture.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await writeClashTicket(fixture, 'demo-aaaa', 'first', parent.id);

  const misplaced = join(fixture.storePath, 'tickets', 'other', 'demo-aaaa-second.md');

  const text = await readFile(
    join(fixture.storePath, 'tickets', 'demo', 'demo-aaaa-first.md'),
    'utf8',
  );

  await mkdir(dirname(misplaced), { recursive: true });
  await writeFile(misplaced, text);

  const logged = await fixture.run([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'Written under an ID only one demo ticket has',
    '--json',
  ]);

  expect(logged.stdout).not.toContain('idShared');
  expect(logged.exitCode).toBe(0);
  expect(await readAllFacts(fixture)).toContain('Written under an ID only one demo ticket has');
});

const sharedIdPaths = (fixture: CliFixture): [string, string] => [
  join(fixture.storePath, 'tickets', 'demo', 'demo-aaaa-first.md'),
  join(fixture.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'),
];

const createSharedIdStore = async (kind = 'instruction'): Promise<CliFixture> => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const parent = await fixture.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await writeClashTicket(fixture, 'demo-aaaa', 'first', parent.id, true, kind);
  await writeClashTicket(fixture, 'demo-aaaa', 'second', parent.id, true, kind);

  return fixture;
};

const expectSharedRefusalWithoutWrites = async (
  fixture: CliFixture,
  args: string[],
): Promise<void> => {
  const paths = sharedIdPaths(fixture);
  const textsBefore = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const factsBefore = await readAllFacts(fixture).catch(() => '');

  const refused = await fixture.run([...args, '--json']);

  expect(refused.exitCode).not.toBe(0);
  expect(runJsonError(refused.stdout)).toBe('idShared');
  expect(await Promise.all(paths.map((path) => readFile(path, 'utf8')))).toEqual(textsBefore);
  expect(await readAllFacts(fixture).catch(() => '')).toBe(factsBefore);
};

it('done refuses a shared ID before it writes the ticket file or a status fact', async () => {
  const fixture = await createSharedIdStore('task');

  await expectSharedRefusalWithoutWrites(fixture, ['done', 'demo-aaaa']);
});

it('cancel refuses a shared ID before it writes the ticket file or a status fact', async () => {
  const fixture = await createSharedIdStore();

  await expectSharedRefusalWithoutWrites(fixture, ['cancel', 'demo-aaaa']);
});

it('unarchive refuses a shared ID before it writes the ticket file or an unarchive fact', async () => {
  const fixture = await createSharedIdStore('task');
  const [first, second] = sharedIdPaths(fixture);
  const parent = (await readFile(second, 'utf8')).match(/^parent: (\S+)$/m)?.[1] ?? '';

  await writeFile(
    first,
    `---\nkind: task\ntitle: first\nproject: demo\nparent: ${parent}\nblockedBy: []\nstatus: done\narchived: 2026-10-01\n---\n`,
  );

  await expectSharedRefusalWithoutWrites(fixture, ['unarchive', 'demo-aaaa']);
});

it('a log refuses an ID whose second ticket file does not parse, and appends no fact', async () => {
  const fixture = await createSharedIdStore();
  const [, second] = sharedIdPaths(fixture);

  await writeFile(second, '---\nkind: broken\n---\n');

  const before = await readAllFacts(fixture).catch(() => '');

  const refused = await fixture.run([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'Written under a shared ID with a broken file',
    '--json',
  ]);

  expect(refused.exitCode).not.toBe(0);
  expect(runJsonError(refused.stdout)).toBe('idShared');
  expect(await readAllFacts(fixture).catch(() => '')).toBe(before);
});

it('a pending renamed ticket keeps its pre-clash facts when the sync that renames it fast-forwards', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B pending progress',
  ]);

  await addOrigin(second, remotePath);
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  await second.runChecked(['sync']);
  await addOrigin(first, remotePath);
  await first.runChecked(['sync']);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A survivor progress',
  ]);

  await first.runChecked(['sync']);

  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  const report = await second.runJson<AliasSyncReport>(['sync']);
  const alias = report.aliases[0];

  invariant(alias !== undefined, 'The clash should write one alias.');

  await second.runChecked(['ls']);

  expect(logTexts(listTicketFacts(second, alias.to))).toEqual(['B pending progress']);
  expect(logTexts(listTicketFacts(second, 'demo-aaaa'))).toEqual(['A survivor progress']);
});

it('a pending clash that a failed resolution left shared keeps the write refused and each ticket its own facts', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B pending-ticket progress',
  ]);

  await addOrigin(second, remotePath);
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  await second.runChecked(['sync']);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A surviving-ticket progress',
  ]);

  await addOrigin(first, remotePath);
  await first.runChecked(['sync']);

  const failingPath = await failNextTreeRead(second, 'demo-aaaa-second.md');
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  const failed = await second.run(['sync'], { path: failingPath });

  expect(failed.exitCode).not.toBe(0);

  const refused = await second.run([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress for surviving A after merge',
    '--json',
  ]);

  expect(refused.exitCode).not.toBe(0);
  expect(runJsonError(refused.stdout)).toBe('idShared');

  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  const retry = await second.runJson<AliasSyncReport>(['sync']);
  const alias = retry.aliases[0];

  invariant(alias !== undefined, 'The retry should write one alias.');
  await second.runChecked(['ls']);

  expect(logTexts(listTicketFacts(second, alias.to))).toEqual(['B pending-ticket progress']);
  expect(logTexts(listTicketFacts(second, 'demo-aaaa'))).toEqual(['A surviving-ticket progress']);
});

it('a write refused after a failed clash commit leaves the retry with each ticket its own facts', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  const offline = join(first.home, 'offline.git');

  await gitOutput(first.storePath, ['remote', 'set-url', 'origin', offline]);
  await writeClashTicket(first, 'demo-aaaa', 'older', parent.id);
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeClashTicket(second, 'demo-aaaa', 'newer', parent.id);
  await second.runChecked(['claim', 'demo-aaaa', '--holder', 'second-agent']);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B progress before clash',
  ]);

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

  const refused = await first.run([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'Written after the failed commit',
    '--json',
  ]);

  expect(refused.exitCode).not.toBe(0);
  expect(runJsonError(refused.stdout)).toBe('idShared');

  await rm(hook);
  await first.runChecked(['sync']);
  await first.runChecked(['ls']);

  const aliasTicket = aliasTicketOf(await readAllFacts(first));

  expect(logTexts(listTicketFacts(first, aliasTicket))).toEqual(['B progress before clash']);
  expect(logTexts(listTicketFacts(first, 'demo-aaaa'))).toEqual([]);
});

it('a second pending clash leaves a fact that an earlier alias moved with the earlier renamed ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id, false);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B log published before its ticket',
  ]);

  await addOrigin(second, remotePath);
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  await second.runChecked(['sync']);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A log for surviving ticket',
  ]);

  await addOrigin(first, remotePath);
  await first.runChecked(['sync']);

  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-second.md'));
  const firstReport = await second.runJson<AliasSyncReport>(['sync']);
  const firstAlias = firstReport.aliases[0];

  invariant(firstAlias !== undefined, 'The first clash should write one alias.');

  await Bun.sleep(settleWaitMilliseconds);
  await second.runChecked(['sync']);
  await first.runChecked(['sync']);

  await rm(join(first.storePath, 'tickets', 'demo', 'demo-aaaa-first.md'));
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'third', parent.id, false);

  await second.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'B second pending progress',
  ]);

  await addOrigin(second, remotePath);
  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-third.md'));
  await second.runChecked(['sync']);

  await writeClashTicket(first, 'demo-aaaa', 'fourth', parent.id);
  await first.runChecked(['log', 'demo-aaaa', '--type', 'progress', '--text', 'A second survivor']);
  await first.runChecked(['sync']);

  await touchFile(join(second.storePath, 'tickets', 'demo', 'demo-aaaa-third.md'));
  const secondReport = await second.runJson<AliasSyncReport>(['sync']);
  const secondAlias = secondReport.aliases[0];

  invariant(secondAlias !== undefined, 'The second clash should write one alias.');

  await Bun.sleep(settleWaitMilliseconds);
  await second.runChecked(['sync']);
  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    await fixture.runChecked(['ls']);

    expect(logTexts(listTicketFacts(fixture, firstAlias.to))).toEqual([
      'B log published before its ticket',
    ]);

    expect(logTexts(listTicketFacts(fixture, secondAlias.to))).toEqual([
      'B second pending progress',
    ]);

    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([
      'A log for surviving ticket',
      'A second survivor',
    ]);
  }
});

it('a retry after a failed clash commit moves a fact written on the other clone after the failure to the renamed ticket', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);
  await removeOrigin(first);
  await removeOrigin(second);

  await writeClashTicket(second, 'demo-aaaa', 'second', parent.id);
  await second.runChecked(['sync']);
  await Bun.sleep(1100);

  await writeClashTicket(first, 'demo-aaaa', 'first', parent.id);
  await first.runChecked(['claim', 'demo-aaaa', '--holder', 'first-agent']);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A progress before clash',
  ]);

  await addOrigin(first, remotePath);
  await addOrigin(second, remotePath);
  await first.runChecked(['sync']);

  const hook = join(second.storePath, '.git', 'hooks', 'pre-commit');

  await mkdir(dirname(hook), { recursive: true });

  await writeFile(
    hook,
    '#!/bin/sh\ngit diff --cached --name-only | grep -q "^facts/" && exit 1\nexit 0\n',
  );

  await chmod(hook, 0o755);

  const failed = await second.run(['sync']);

  expect(failed.exitCode).not.toBe(0);

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A progress after failed commit',
  ]);

  await first.runChecked(['sync']);

  await rm(hook);
  const retry = await second.runJson<AliasSyncReport>(['sync']);
  const alias = retry.aliases[0];

  invariant(alias !== undefined, 'The retry should reuse the alias.');
  expect(alias.from).toBe('demo-aaaa');

  await first.runChecked(['sync']);

  for (const fixture of [second, first]) {
    await fixture.runChecked(['ls']);

    expect(logTexts(listTicketFacts(fixture, alias.to))).toEqual([
      'A progress before clash',
      'A progress after failed commit',
    ]);

    expect(logTexts(listTicketFacts(fixture, 'demo-aaaa'))).toEqual([]);
  }
});

it('a second clash after a failed alias commit moves the renamed ticket later facts to it', async () => {
  const { first, second, remotePath } = clonePair();

  const third = await createCliFixture('tikk-sync-third-', {
    machine: 'third',
    remotePath,
    syncDelays,
  });

  try {
    await first.runChecked(['init', '--remote', remotePath]);
    await second.runChecked(['init', '--remote', remotePath]);
    await third.runChecked(['init', '--remote', remotePath]);

    const parent = await first.runJson<ShownInstruction>([
      'new',
      'slice',
      'Shared parent',
      '--status',
      'draft',
    ]);

    await ageFile(parent.path);
    await first.runChecked(['sync']);
    await second.runChecked(['sync']);
    await removeOrigin(third);

    await writeClashTicket(third, 'demo-bbbb', 'older-b', parent.id);
    await third.runChecked(['sync']);

    await writeClashTicket(first, 'demo-aaaa', 'older-a', parent.id);
    await first.runChecked(['sync']);
    await Bun.sleep(1100);

    await removeOrigin(second);
    await writeClashTicket(second, 'demo-aaaa', 'newer-a', parent.id);
    await second.runChecked(['sync']);
    await addOrigin(second, remotePath);

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

    await removeOrigin(second);
    await writeClashTicket(second, 'demo-bbbb', 'newer-b', parent.id);

    await second.runChecked([
      'log',
      'demo-bbbb',
      '--type',
      'progress',
      '--text',
      'B fact after pending alias',
    ]);

    await second.runChecked(['sync']);

    for (const [file, diskText] of await readFactFiles(second)) {
      const headText = await gitShowOrEmpty(second.storePath, `HEAD:facts/${file}`);

      expect(diskText.startsWith(headText)).toBe(true);
    }

    await addOrigin(third, remotePath);
    await third.runChecked(['sync']);
    await addOrigin(second, remotePath);

    const retry = await second.runJson<AliasSyncReport>(['sync']);
    const alias = retry.aliases.find((entry) => entry.from === 'demo-bbbb');

    invariant(alias !== undefined, 'The retry should rename the newer demo-bbbb.');

    await second.runChecked(['ls']);

    expect(logTexts(listTicketFacts(second, alias.to))).toEqual(['B fact after pending alias']);
    expect(logTexts(listTicketFacts(second, 'demo-bbbb'))).toEqual([]);
  } finally {
    await third.cleanup();
  }
});

it('a later sync commits an alias whose clash was abandoned by hand, with the facts after it', async () => {
  const { first, second, remotePath } = clonePair();

  await first.runChecked(['init', '--remote', remotePath]);
  await second.runChecked(['init', '--remote', remotePath]);

  const parent = await first.runJson<ShownInstruction>([
    'new',
    'slice',
    'Shared parent',
    '--status',
    'draft',
  ]);

  await ageFile(parent.path);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  const offline = join(first.home, 'offline.git');

  await gitOutput(first.storePath, ['remote', 'set-url', 'origin', offline]);
  await writeClashTicket(first, 'demo-aaaa', 'older', parent.id);
  await first.runChecked(['sync']);
  await Bun.sleep(1100);
  await writeClashTicket(second, 'demo-aaaa', 'newer', parent.id);
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

  const abandoned = aliasTicketOf(await readAllFacts(first));

  await rm(join(first.storePath, 'tickets', 'demo', 'demo-aaaa-newer.md'));

  await first.runChecked([
    'log',
    'demo-aaaa',
    '--type',
    'progress',
    '--text',
    'A log after the abandoned clash',
  ]);

  await rm(hook);
  await first.runChecked(['sync']);
  await second.runChecked(['sync']);

  await second.runChecked(['ls']);

  expect(await readAllFacts(second)).toContain('A log after the abandoned clash');

  expect(logTexts(listTicketFacts(second, 'demo-aaaa'))).toEqual([
    'A log after the abandoned clash',
  ]);

  expect(logTexts(listTicketFacts(second, abandoned))).toEqual([]);

  for (const [file, diskText] of await readFactFiles(first)) {
    const headText = await gitShowOrEmpty(first.storePath, `HEAD:facts/${file}`);

    expect(diskText.startsWith(headText)).toBe(true);
  }
});

it('a new ticket skips an ID that a chained alias hides from the projected fact list', async () => {
  const fixture = singleFixture();

  await fixture.runChecked(['init']);

  const factsDirectory = join(fixture.storePath, 'facts', 'desk');
  const ticketsDirectory = join(fixture.storePath, 'tickets', 'demo');
  const firstAlias = `${JSON.stringify({ version: 1, ticket: 'demo-bbbb', at: '2026-10-20T10:00:00.000Z', machine: 'desk', kind: 'alias', from: 'demo-aaaa' })}\n`;
  const chainedAlias = `${JSON.stringify({ version: 1, ticket: 'demo-cccc', at: '2026-10-20T11:00:00.000Z', machine: 'desk', kind: 'alias', from: 'demo-bbbb', movedFacts: [{ path: 'desk/2026-10.jsonl', line: 1 }] })}\n`;

  await mkdir(factsDirectory, { recursive: true });
  await mkdir(ticketsDirectory, { recursive: true });
  await writeFile(join(factsDirectory, '2026-10.jsonl'), firstAlias + chainedAlias);

  await writeFile(
    join(ticketsDirectory, 'demo-cccc-renamed.md'),
    '---\nkind: task\ntitle: Renamed\nproject: demo\nstatus: open\n---\n',
  );

  const suffixes = ['bbbb', 'zzzz'];

  const opened = await createOpenSession(
    fixture.storePath,
    join(fixture.home, '.cache', 'tikk', 'index.db'),
    { ...nodeTicketFiles, randomIdSuffix: () => suffixes.shift() ?? 'zzzz' },
  )();

  invariant(opened.ok, 'The session should open.');

  const session = opened.value;

  await session.refresh();

  const project = parseProjectName('demo');

  invariant(project.ok, 'The project name should parse.');

  const created = await session.createTicketFile(project.value, 'New', 'New ticket.\n');

  expect(created).toMatchObject({ ok: true, value: { id: 'demo-zzzz' } });
  session[Symbol.dispose]();
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
  await Bun.sleep(syncDelays.debounceMilliseconds / 2);

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
