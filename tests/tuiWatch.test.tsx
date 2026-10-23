import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { createTestRenderer } from '@opentui/core/testing';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { createRoot } from '@opentui/react';
import { act } from 'react';

import { openNeedsSession } from '../src/cli/cli.ts';
import type { CliEffects, NeedsSession } from '../src/cli/cli.ts';
import { createEffects, watchStore } from '../src/index.ts';
import { invariant } from '../src/invariant.ts';
import { startTerminal } from '../src/terminal.tsx';
import type { TerminalEffects } from '../src/terminal.tsx';
import { createCliFixture, waitForBackgroundSync } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { createFakeGh } from './fakeGh.ts';
import type { FakeGh } from './fakeGh.ts';

type Handler = (reason?: unknown) => void;
type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

interface Started {
  setup: Setup;
  loads: () => number;
  stop: () => Promise<void>;
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const prUrl = 'https://github.com/acme/app/pull/7';

let fixture: CliFixture | undefined;
let started: Started | undefined;
let gh: FakeGh | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const testEffects = (setup: Setup, handlers: Map<string, Handler>, exits: number[]) => {
  const root = createRoot(setup.renderer);

  const effects: TerminalEffects = {
    open: () =>
      Promise.resolve({
        renderer: {
          suspend: () => undefined,
          resume: () => undefined,
          destroy: () => {
            act(() => {
              setup.renderer.destroy();
            });
          },
        },
        root: {
          render: (node) => {
            root.render(node);
          },
          unmount: () => {
            act(() => {
              root.unmount();
            });
          },
        },
        keymap: createDefaultOpenTuiKeymap(setup.renderer),
      }),
    listen: (event, handler) => {
      handlers.set(event, handler);

      return () => handlers.delete(event);
    },
    exit: (code) => exits.push(code),
    printError: () => undefined,
  };

  return effects;
};

const waitUntil = async (setup: Setup, ready: () => boolean, milliseconds: number) => {
  const deadline = Date.now() + milliseconds;

  while (!ready() && Date.now() < deadline) {
    await act(async () => {
      await Bun.sleep(25);
      await setup.renderOnce();
    });
  }
};

const start = async (cliEffects: CliEffects): Promise<Started> => {
  const opened = await openNeedsSession(cliEffects);

  invariant(opened.ok, 'The needs session should open.');

  let loadCount = 0;

  const needs: NeedsSession = {
    ...opened.value,
    load: () => {
      loadCount += 1;

      return opened.value.load();
    },
  };

  const setup = await createTestRenderer({ width: 100, height: 20 });
  const handlers = new Map<string, Handler>();
  const exits: number[] = [];

  await act(async () => {
    await startTerminal(
      { needs, watch: watchStore(cli().storePath) },
      testEffects(setup, handlers, exits),
    );
  });

  await waitUntil(setup, () => !setup.captureCharFrame().includes('Loading...'), 10_000);

  const stop = async () => {
    handlers.get('SIGTERM')?.();
    await waitUntil(setup, () => exits.length > 0, 10_000);
  };

  return { setup, loads: () => loadCount, stop };
};

const createSlice = async (): Promise<string> => {
  const criteria = join(cli().home, 'criteria.yaml');

  await Bun.write(criteria, '- id: works\n  check: Run it\n  expected: It works\n');

  const plan = await cli().runJson<{ id: string }>([
    'new',
    'plan',
    'A plan',
    '--criteria-file',
    criteria,
  ]);

  const slice = await cli().runJson<{ id: string }>([
    'new',
    'slice',
    'A slice',
    '--parent',
    plan.id,
    '--criteria-file',
    criteria,
  ]);

  return slice.id;
};

const mergedPullRequest = JSON.stringify({
  number: 7,
  state: 'MERGED',
  baseRefName: 'main',
  headRefOid: 'head1',
  mergeCommit: { oid: 'merge1' },
});

const mergedGh: CliEffects['runGh'] = (args) => {
  const [command] = args;

  if (command === 'repo') {
    return Promise.resolve({
      ok: true,
      value: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
    });
  }

  if (command === 'api') {
    return Promise.resolve({ ok: true, value: 'ahead' });
  }

  return Promise.resolve({ ok: true, value: mergedPullRequest });
};

beforeEach(async () => {
  gh = await createFakeGh({ state: 'OPEN', base: 'main', head: 'head1', mergeCommit: null });
  fixture = await createCliFixture('tikk-tui-watch-', { pathPrefix: gh.directory });
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await started?.stop();
  started = undefined;
  await fixture?.cleanup();
  await gh?.cleanup();
});

it('shows a fact that another process writes without a restart', async () => {
  const created = await cli().runJson<{ id: string }>(['new', 'task', 'Asked task']);
  const effects = createEffects(cli().storePath, join(cli().home, 'index.db'));

  started = await start(effects);

  const { setup } = started;

  expect(setup.captureCharFrame()).toContain('Nothing needs you.');

  await cli().runJson(['log', created.id, '--type', 'question', '--text', 'Which one?']);

  const shown = () =>
    setup
      .captureCharFrame()
      .split('\n')
      .some((line) => line.includes(created.id) && line.includes('question'));

  await waitUntil(setup, shown, 5000);

  expect(shown()).toBe(true);
});

it('reloads once more after a reload whose PR reconcile appends a fact, and then settles', async () => {
  const slice = await createSlice();

  await cli().runJson(['pr', 'link', slice, prUrl]);
  await waitForBackgroundSync(cli().storePath);

  const effects = createEffects(cli().storePath, join(cli().home, 'index.db'));

  started = await start({ ...effects, runGh: mergedGh, scheduleSync: () => Promise.resolve() });

  const { setup } = started;
  const merged = () => setup.captureCharFrame().includes('mergedUnverified');

  await waitUntil(setup, merged, 5000);
  await waitUntil(setup, () => false, 1500);

  expect(merged()).toBe(true);
  expect(started.loads()).toBe(2);
});
