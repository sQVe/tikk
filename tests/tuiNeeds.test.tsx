import { afterEach, beforeEach, expect, it } from 'bun:test';
import { join } from 'node:path';

import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { useRenderer } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import { act, useMemo } from 'react';
import type { ReactNode } from 'react';

import { openNeedsSession } from '../src/cli/cli.ts';
import type { NeedsSession } from '../src/cli/cli.ts';
import { createEffects } from '../src/index.ts';
import { invariant } from '../src/invariant.ts';
import { App } from '../src/tui/tui.tsx';
import type { AppProps } from '../src/tui/tui.tsx';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';

interface NeedsListing {
  items: { id: string; reason: string }[];
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const loadTimeoutMilliseconds = 10_000;

let fixture: CliFixture | undefined;
let needs: NeedsSession | undefined;
let mounted: Awaited<ReturnType<typeof testRender>> | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const WithKeymap = (props: Omit<AppProps, 'keymap'>): ReactNode => {
  const renderer = useRenderer();
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  return <App {...props} keymap={keymap} />;
};

const createTask = async (title: string): Promise<string> => {
  const created = await cli().runJson<{ id: string }>(['new', 'task', title]);

  return created.id;
};

const openHome = async () => {
  const effects = createEffects(cli().storePath, join(cli().home, 'index.db'));
  const opened = await openNeedsSession(effects);

  invariant(opened.ok, 'The needs session should open.');
  needs = opened.value;

  const setup = await act(() =>
    testRender(<WithKeymap effects={opened.value} onQuit={() => undefined} />, {
      width: 100,
      height: 20,
    }),
  );

  const deadline = Date.now() + loadTimeoutMilliseconds;

  while (Date.now() < deadline) {
    await act(async () => {
      await Bun.sleep(25);
      await setup.renderOnce();
    });

    if (!setup.captureCharFrame().includes('Loading...')) {
      break;
    }
  }

  mounted = setup;

  return setup;
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-tui-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  act(() => {
    mounted?.renderer.destroy();
  });

  mounted = undefined;
  await needs?.close();
  needs = undefined;
  await fixture?.cleanup();
});

it('lists the items of tikk needs in the same order', async () => {
  const asked = await createTask('Asked task');
  const submitted = await createTask('Submitted task');

  await cli().runJson(['log', asked, '--type', 'question', '--text', 'Which one?']);
  await cli().runJson(['claim', submitted, '--holder', 'agent']);
  await cli().runJson(['submit', submitted, '--holder', 'agent']);

  const listing = await cli().runJson<NeedsListing>(['needs']);
  const setup = await openHome();

  const ids = listing.items.map((item) => item.id);

  const rows = setup
    .captureCharFrame()
    .split('\n')
    .filter((line) => ids.some((id) => line.includes(id)));

  expect(listing.items.length).toBeGreaterThanOrEqual(2);
  expect(rows).toHaveLength(listing.items.length);

  for (const [index, item] of listing.items.entries()) {
    expect(rows[index]).toContain(item.id);
    expect(rows[index]).toContain(item.reason);
  }
});

it('says that nothing needs the user when the list is empty', async () => {
  await createTask('Plain task');

  const setup = await openHome();

  expect(setup.captureCharFrame()).toContain('Nothing needs you.');
});
