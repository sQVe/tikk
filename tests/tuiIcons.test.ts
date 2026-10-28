import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { invariant } from '../src/invariant.ts';
import { createCliFixture } from './cliFixture.ts';
import type { CliFixture } from './cliFixture.ts';
import { screenOf, startTerminalTikk, writeEditorScript } from './tuiTerminalFixture.ts';

// The Nerd Font glyph for a plan, and the Unicode glyph the default set uses for it.
const nerdFontPlanIcon = '\uf279';
const unicodePlanIcon = '◆';

let fixture: CliFixture | undefined;

const cli = (): CliFixture => {
  invariant(fixture !== undefined, 'The CLI fixture should be set up.');

  return fixture;
};

const writeConfig = async (config: unknown): Promise<void> => {
  const configDirectory = join(cli().home, '.config', 'tikk');

  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, 'config.json'), JSON.stringify(config));
};

beforeEach(async () => {
  fixture = await createCliFixture('tikk-tui-icons-');
  await cli().runChecked(['init']);
});

afterEach(async () => {
  await fixture?.cleanup();
});

// Starts the TUI, opens the Projects view, and returns the screen line that shows the plan.
const planLineInProjects = async (): Promise<string> => {
  const plan = await cli().runJson<{ id: string }>(['new', 'plan', 'aaaa', '--status', 'draft']);
  const editorPath = await writeEditorScript(cli().home, '#!/bin/sh\n');
  const tikk = startTerminalTikk(cli(), editorPath);

  try {
    await tikk.waitForScreen('Nothing needs you.');

    tikk.type('s');
    await tikk.waitForScreen(plan.id);

    const line = screenOf(tikk.terminal.output).lines.find((text) => text.includes(plan.id));

    invariant(line !== undefined, 'The plan row should be on the screen.');

    tikk.type('q');

    expect(await tikk.child.exited).toBe(0);

    return line;
  } finally {
    tikk.close();
  }
};

it('draws Nerd Font row icons when the config sets icons to nerdFont', async () => {
  await writeConfig({ icons: 'nerdFont' });

  const line = await planLineInProjects();

  expect(line).toContain(nerdFontPlanIcon);
  expect(line).not.toContain(unicodePlanIcon);
}, 30_000);

it('draws Unicode row icons when the config does not set icons', async () => {
  const line = await planLineInProjects();

  expect(line).toContain(unicodePlanIcon);
  expect(line).not.toContain(nerdFontPlanIcon);
}, 30_000);
