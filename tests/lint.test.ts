import { expect, it, onTestFinished } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LintRun {
  status: number | null;
  diagnostics: string[];
}

const root = fileURLToPath(new URL('../', import.meta.url));

const lintProject = async (files: Record<string, string>): Promise<LintRun> => {
  const directory = await mkdtemp(join(tmpdir(), 'tikk-lint-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  // The `src` segment above the project root must not count as the application source.
  const project = join(directory, 'src', 'project');

  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{}\n');

  for (const [file, source] of Object.entries(files)) {
    const path = join(project, file);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }

  const result = spawnSync(process.execPath, ['run', 'lint', project, '--format', 'unix'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(result.error).toBeUndefined();

  const diagnostics = result.stdout.split('\n').filter((line) => line.includes('tikk('));

  return { status: result.status, diagnostics };
};

it('refuses a Node built-in in the ticket module', async () => {
  const run = await lintProject({
    'src/ticket/ticket.ts':
      "import { readFileSync } from 'node:fs';\nexport const ticket = readFileSync;\n",
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(1);
  expect(run.diagnostics[0]).toContain('src/ticket/ticket.ts');
  expect(run.diagnostics[0]).toContain('tikk(module-boundaries)');
}, 30_000);

it('refuses an import from the cache module in the store module', async () => {
  const run = await lintProject({
    'src/cache/cache.ts': 'export const cache = 1;\n',
    'src/store/store.ts':
      "import { cache } from '../cache/cache.ts';\nexport const store = cache;\n",
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(1);
  expect(run.diagnostics[0]).toContain('src/store/store.ts');
  expect(run.diagnostics[0]).toContain('tikk(module-boundaries)');
}, 30_000);

it('refuses a file outside the modules and an npm package outside the table', async () => {
  const run = await lintProject({
    'src/stray.ts': 'export const stray = 1;\n',
    'src/store/store.ts': "import { z } from 'zod';\nexport const store = z;\n",
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(2);
}, 30_000);

it('passes imports the table allows', async () => {
  const run = await lintProject({
    'src/invariant.ts': 'export const invariant = 1;\n',
    'src/result.ts': 'export type Result = { ok: true };\n',
    'src/ticket/ticket.ts':
      "import { z } from 'zod';\nimport { invariant } from '../invariant.ts';\nimport { parse } from './ticketParse.ts';\nexport const ticket = [z, invariant, parse];\n",
    'src/ticket/ticketParse.ts':
      "import type { Result } from '../result.ts';\nexport type { Result };\nexport const parse = 1;\n",
    'src/ticket/ticket.test.ts':
      "import { expect, it } from 'bun:test';\nimport { readFileSync } from 'node:fs';\nimport { ticket } from './ticket.ts';\nit('loads', () => expect([ticket, readFileSync]).toHaveLength(2));\n",
    'src/store/store.ts':
      "import { readFileSync } from 'node:fs';\nimport { ticket } from '../ticket/ticket.ts';\nexport const store = [readFileSync, ticket];\n",
    'src/cli/cli.ts':
      "import { parseArgs } from 'node:util';\nimport packageJson from '../../package.json' with { type: 'json' };\nimport { ticket } from '../ticket/ticket.ts';\nexport const cli = [parseArgs, packageJson, ticket];\n",
    'src/index.ts':
      "import { cli } from './cli/cli.ts';\nimport { store } from './store/store.ts';\nexport const index = [cli, store];\n",
  });

  expect(run.diagnostics).toEqual([]);
}, 30_000);

it('refuses a throw outside the invariant module', async () => {
  const run = await lintProject({
    'src/invariant.ts': "export const invariant = () => {\n  throw new Error('bug');\n};\n",
    'src/store/store.ts': "export const store = () => {\n  throw new Error('bug');\n};\n",
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(1);
  expect(run.diagnostics[0]).toContain('src/store/store.ts');
  expect(run.diagnostics[0]).toContain('tikk(throw-only-in-invariant)');
}, 30_000);

it('refuses a forbidden module reached by a literal dynamic import, require, or import-equals', async () => {
  const run = await lintProject({
    'src/ticket/ticketA.ts': "export const load = () => import('node:fs');\n",
    'src/ticket/ticketB.ts': "export const load = () => require('node:fs');\n",
    'src/ticket/ticketC.ts': "import fs = require('node:fs');\nexport const load = fs;\n",
    'src/ticket/ticketD.ts': 'export const load = () => import(`node:fs`);\n',
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(4);

  for (const file of ['ticketA', 'ticketB', 'ticketC', 'ticketD']) {
    const diagnostic = run.diagnostics.find((line) => line.includes(`src/ticket/${file}.ts`));

    expect(diagnostic).toContain('tikk(module-boundaries)');
  }
}, 30_000);

it('refuses a computed dynamic import and passes a literal one the table allows', async () => {
  const run = await lintProject({
    'src/invariant.ts': 'export const invariant = 1;\n',
    'src/ticket/ticket.ts':
      "export const load = (name: string) => import(name);\nexport const ok = () => import('../invariant.ts');\n",
  });

  expect(run.status).toBe(1);
  expect(run.diagnostics).toHaveLength(1);
  expect(run.diagnostics[0]).toContain('src/ticket/ticket.ts');
}, 30_000);
