import { Database } from 'bun:sqlite';
import { beforeEach, afterEach, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ShownTicket {
  id: string;
  path: string;
  hash: string;
  title: string;
  status: string;
  error: string | null;
  body: string;
}

interface Listing {
  tickets: ShownTicket[];
  errors: { path: string; message: string }[];
}

const entryPath = join(import.meta.dir, '..', 'src', 'index.ts');

let home = '';
let work = '';

const run = async (args: string[], extraEnvironment: Record<string, string> = {}) => {
  const child = Bun.spawn(['bun', 'run', entryPath, ...args], {
    cwd: work,
    env: { ...process.env, HOME: home, TIKK_HOME: join(home, 'store'), ...extraEnvironment },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  const result: RunResult = { exitCode, stdout, stderr };

  return result;
};

const runJson = async <Shape>(args: string[]): Promise<Shape> => {
  const result = await run([...args, '--json']);

  expect(result.exitCode).toBe(0);

  return JSON.parse(result.stdout) as Shape;
};

const createTask = async (title: string): Promise<ShownTicket> => {
  await run(['init', '--json']);

  return runJson<ShownTicket>(['new', 'task', title]);
};

const errorCodeOf = (result: RunResult): unknown => {
  const parsed: unknown = JSON.parse(result.stdout);

  return (parsed as { error: { code: string } }).error.code;
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tikk-files-'));
  work = join(home, 'work');
  await Bun.write(join(work, '.keep'), '');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it('shows the new title after a file is edited on disk', async () => {
  const created = await createTask('First');
  const text = await readFile(created.path, 'utf8');

  await writeFile(created.path, text.replace('title: First', 'title: Renamed'));

  const shown = await runJson<ShownTicket>(['show', created.id]);

  expect(shown.title).toBe('Renamed');
});

it('lists the same tickets after the cache database is deleted', async () => {
  await createTask('First');
  await runJson<ShownTicket>(['new', 'issue', 'Second']);

  const before = await runJson<Listing>(['ls']);

  await rm(join(home, '.cache', 'tikk', 'index.db'), { force: true });

  const after = await runJson<Listing>(['ls']);

  expect(before.tickets).toHaveLength(2);
  expect(after).toEqual(before);
});

it('refuses an edit with an old hash and leaves the file unchanged', async () => {
  const created = await createTask('First');
  const text = await readFile(created.path, 'utf8');

  await writeFile(created.path, text.replace('title: First', 'title: Changed'));

  const before = await readFile(created.path);
  const result = await run(['edit', created.id, '--hash', created.hash, '--title', 'X', '--json']);
  const after = await readFile(created.path);

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('changedOnDisk');
  expect(after.equals(before)).toBe(true);
});

it('edits the title and status when the hash matches', async () => {
  const created = await createTask('First');

  const edited = await runJson<ShownTicket>([
    'edit',
    created.id,
    '--hash',
    created.hash,
    '--title',
    'Second',
    '--status',
    'draft',
  ]);

  const shown = await runJson<ShownTicket>(['show', created.id]);

  expect(edited.title).toBe('Second');
  expect(shown.title).toBe('Second');
  expect(shown.status).toBe('draft');
});

it('keeps the last good state for a file with broken front matter', async () => {
  const created = await createTask('First');

  await writeFile(created.path, '---\nkind: [\n---\nBroken\n');

  const shown = await runJson<ShownTicket>(['show', created.id]);
  const listing = await runJson<Listing>(['ls']);

  expect(shown.title).toBe('First');
  expect(shown.error).not.toBeNull();
  expect(listing.errors).toHaveLength(1);
  expect(listing.errors[0]?.path).toBe(created.path);
  expect(listing.errors[0]?.message).not.toBe('');
});

it('shows the parse error of a broken file in plain show and after a human edit', async () => {
  const created = await createTask('First');
  const editor = join(home, 'break.sh');

  await writeFile(editor, '#!/bin/sh\nprintf "garbage\\n" > "$1"\n');
  await chmod(editor, 0o755);

  const edited = await run(['edit', created.id], { EDITOR: editor });
  const shown = await runJson<ShownTicket>(['show', created.id]);
  const plain = await run(['show', created.id]);

  expect(shown.error).not.toBeNull();
  expect(edited.stdout).toContain(shown.error ?? '');
  expect(plain.stdout).toContain(shown.error ?? '');
});

it('refuses a JSON edit of a file with a parse error', async () => {
  const created = await createTask('First');

  await writeFile(created.path, '---\nkind: [\n---\nBroken\n');

  const result = await run(['edit', created.id, '--hash', 'x', '--title', 'X', '--json']);

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('parseError');
});

it('exits 1 with a JSON error for an unknown ID', async () => {
  await run(['init', '--json']);

  const result = await run(['show', 'tikk-3333', '--json']);

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('notFound');
});

it('exits 1 with a JSON error for each command before init', async () => {
  const commands = [
    ['show', 'tikk-3333'],
    ['ls'],
    ['new', 'task', 'First'],
    ['edit', 'tikk-3333', '--hash', 'x', '--title', 'X'],
  ];

  for (const command of commands) {
    const result = await run([...command, '--json']);

    expect(result.exitCode).toBe(1);
    expect(errorCodeOf(result)).toBe('notInitialized');
  }
});

it('exits 1 for a JSON edit with no field flag without opening an editor', async () => {
  const created = await createTask('First');
  const marker = join(home, 'editor-ran');
  const editor = join(home, 'editor.sh');

  await writeFile(editor, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });

  const result = await run(['edit', created.id, '--hash', created.hash, '--json'], {
    EDITOR: editor,
  });

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('invalidArguments');
  expect(existsSync(marker)).toBe(false);
});

it('opens $EDITOR on the file for a human edit and shows the change', async () => {
  const created = await createTask('First');
  const editor = join(home, 'editor.sh');

  await writeFile(editor, `#!/bin/sh\nsed -i 's/title: First/title: Edited/' "$1"\n`, {
    mode: 0o755,
  });

  const result = await run(['edit', created.id], { EDITOR: editor });
  const shown = await runJson<ShownTicket>(['show', created.id]);

  expect(result.exitCode).toBe(0);
  expect(shown.title).toBe('Edited');
});

it('reports whether init created the store', async () => {
  const first = JSON.parse((await run(['init', '--json'])).stdout) as {
    store: string;
    created: boolean;
  };

  const second = JSON.parse((await run(['init', '--json'])).stdout) as { created: boolean };

  expect(first.store).toBe(join(home, 'store'));
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
});

it('creates a ticket with a body from a file and hides archived tickets in ls', async () => {
  await run(['init', '--json']);

  const bodyFile = join(home, 'body.md');

  await writeFile(bodyFile, 'Details.\n');

  const created = await runJson<ShownTicket>([
    'new',
    'issue',
    'With body',
    '--body-file',
    bodyFile,
  ]);

  const text = await readFile(created.path, 'utf8');

  await writeFile(created.path, text.replace('status: open', 'status: open\narchived: 2026-01-01'));

  const visible = await runJson<Listing>(['ls']);
  const all = await runJson<Listing>(['ls', '--archived']);

  expect(created.body).toBe('Details.\n');
  expect(visible.tickets).toHaveLength(0);
  expect(all.tickets).toHaveLength(1);
  expect(all.tickets[0]).not.toHaveProperty('body');
});

it('exits 1 with a storeError when the cache folder cannot be created', async () => {
  const created = await createTask('First');
  const before = await readFile(created.path);

  await rm(join(home, '.cache'), { recursive: true, force: true });
  await writeFile(join(home, '.cache'), 'not a folder');

  const result = await run(['ls', '--json']);
  const after = await readFile(created.path);

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('storeError');
  expect(after.equals(before)).toBe(true);
});

it('exits 1 with a storeError when init cannot create the store folder', async () => {
  const blocker = join(home, 'blocker');

  await writeFile(blocker, 'not a folder');

  const result = await run(['init', '--json'], { TIKK_HOME: join(blocker, 'store') });

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('storeError');
  expect(await readFile(blocker, 'utf8')).toBe('not a folder');
});

it('repairs a ticket that never parsed through $EDITOR and refuses a JSON edit', async () => {
  await run(['init', '--json']);

  const path = join(home, 'store', 'tickets', 'tikk', 'tikk-3a4b-broken.md');
  const editor = join(home, 'editor.sh');
  const repaired = '---\\nkind: task\\ntitle: Repaired\\nproject: tikk\\nstatus: open\\n---\\n';

  await Bun.write(path, '---\nkind: [\n---\nBroken\n');
  await writeFile(editor, `#!/bin/sh\nprintf '%b' '${repaired}' > "$1"\n`, { mode: 0o755 });

  const refused = await run(['edit', 'tikk-3a4b', '--hash', 'x', '--title', 'X', '--json']);
  const edited = await run(['edit', 'tikk-3a4b'], { EDITOR: editor });
  const shown = await runJson<ShownTicket>(['show', 'tikk-3a4b']);

  expect(refused.exitCode).toBe(1);
  expect(errorCodeOf(refused)).toBe('parseError');
  expect(edited.exitCode).toBe(0);
  expect(shown.title).toBe('Repaired');
});

it('creates a ticket in the project named by --project', async () => {
  await run(['init', '--json']);

  const created = await runJson<ShownTicket & { project: string }>([
    'new',
    'task',
    'Elsewhere',
    '--project',
    'other',
  ]);

  expect(created.project).toBe('other');
  expect(created.id.startsWith('other-')).toBe(true);
  expect(created.path).toContain(join('tickets', 'other'));
});

it('lists only the tickets of the project named by --project', async () => {
  await run(['init', '--json']);
  await runJson<ShownTicket>(['new', 'task', 'Here', '--project', 'tikk']);

  const other = await runJson<ShownTicket>(['new', 'task', 'There', '--project', 'other']);
  const listing = await runJson<Listing>(['ls', '--project', 'other']);

  expect(listing.tickets.map((ticket) => ticket.id)).toEqual([other.id]);
});

it('refuses init and keeps tikk.json when it cannot be read', async () => {
  await run(['init', '--json']);

  const config = join(home, 'store', 'tikk.json');
  const original = '{"version": 9, "preserve": "user data"}\n';

  await writeFile(config, original);
  await chmod(config, 0o200);

  const result = await run(['init', '--json']);

  await chmod(config, 0o600);

  expect(result.exitCode).toBe(1);
  expect(errorCodeOf(result)).toBe('storeError');
  expect(await readFile(config, 'utf8')).toBe(original);
});

it('rebuilds a cache database with a damaged page and lists the same tickets', async () => {
  await createTask('Keep me');

  const before = await runJson<Listing>(['ls']);
  const databasePath = join(home, '.cache', 'tikk', 'index.db');
  const database = new Database(databasePath);
  const pageSize = (database.query('PRAGMA page_size').get() as { page_size: number }).page_size;
  const rootRow = database.query("SELECT rootpage FROM sqlite_master WHERE name = 'tickets'").get();
  const rootPage = (rootRow as { rootpage: number }).rootpage;

  database.close();

  const handle = await open(databasePath, 'r+');

  await handle.write(new Uint8Array(pageSize), 0, pageSize, (rootPage - 1) * pageSize);
  await handle.close();

  const result = await run(['ls', '--json']);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(before);
});

it('ignores stray files in tickets and in a project folder', async () => {
  const created = await createTask('Keep me');

  await writeFile(join(home, 'store', 'tickets', '.DS_Store'), 'metadata');
  await writeFile(join(dirname(created.path), '.DS_Store'), 'metadata');

  const listing = await runJson<Listing>(['ls']);

  expect(listing.tickets.map((ticket) => ticket.id)).toEqual([created.id]);
  expect(listing.errors).toEqual([]);
});

it('rebuilds a cache row that passes the integrity check but does not parse', async () => {
  await createTask('Keep me');

  const before = await runJson<Listing>(['ls']);
  const database = new Database(join(home, '.cache', 'tikk', 'index.db'));

  database.run("UPDATE tickets SET blocked_by = '[x'");
  database.close();

  const result = await run(['ls', '--json']);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(before);
});

it('reads a ticket hand edited with CRLF line endings', async () => {
  const created = await createTask('First');
  const text = await readFile(created.path, 'utf8');

  await writeFile(
    created.path,
    text.replace('title: First', 'title: Crlf').replaceAll('\n', '\r\n'),
  );

  const shown = await runJson<ShownTicket>(['show', created.id]);

  expect(shown.title).toBe('Crlf');
  expect(shown.error).toBeNull();
});
