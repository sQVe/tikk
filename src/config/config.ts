import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestKeymap } from '@opentui/keymap/testing';
import { z } from 'zod';

import type { Result } from '../result.ts';
import type { Command } from '../tui/tui.tsx';
import { catalog } from '../tui/tui.tsx';
import { remapCatalog } from './remap.ts';
import type { ConfigFile } from './remap.ts';

type FileRead =
  | { kind: 'missing' }
  | { kind: 'text'; text: string }
  | { kind: 'failed'; reason: string };

export interface ConfigEffects {
  readFile: (path: string) => FileRead;
}

export interface ConfigLoad {
  catalog: readonly Command[];
  messages: string[];
}

const configSchema = z.strictObject({
  version: z.literal(1),
  keys: z.record(z.string(), z.array(z.string())).optional(),
});

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const defaultEffects: ConfigEffects = {
  readFile: (path) => {
    try {
      return { kind: 'text', text: readFileSync(path, 'utf8') };
    } catch (error) {
      if (isMissingFile(error)) {
        return { kind: 'missing' };
      }

      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  },
};

const configPathOf = (environment: Record<string, string | undefined>): string | undefined => {
  const configHome = environment['XDG_CONFIG_HOME'];

  if (configHome !== undefined && configHome !== '') {
    return join(configHome, 'tikk', 'config.json');
  }

  const home = environment['HOME'];

  if (home !== undefined && home !== '') {
    return join(home, '.config', 'tikk', 'config.json');
  }

  return undefined;
};

const shapeMessageOf = (error: z.ZodError, path: string): string => {
  const [issue] = error.issues;

  if (issue === undefined) {
    return `${path}: The file is not a valid config.`;
  }

  const where = issue.path.length === 0 ? 'the top level' : issue.path.map(String).join('.');

  return `${path}: ${where} is not valid. ${issue.message}`;
};

const parseConfigText = (text: string, path: string): Result<ConfigFile, string> => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${path}: The file is not valid JSON.` };
  }

  const shape = configSchema.safeParse(value);

  if (!shape.success) {
    return { ok: false, reason: shapeMessageOf(shape.error, path) };
  }

  return { ok: true, value: { keys: shape.data.keys ?? {} } };
};

const defaultsWith = (message: string): ConfigLoad => ({ catalog, messages: [message] });

const loadText = (text: string, path: string): ConfigLoad => {
  const file = parseConfigText(text, path);

  if (!file.ok) {
    return defaultsWith(file.reason);
  }

  const harness = createTestKeymap({ defaultKeys: true });
  const remapped = remapCatalog(file.value, path, harness.keymap);

  harness.cleanup();

  if (!remapped.ok) {
    return defaultsWith(remapped.reason);
  }

  return { catalog: remapped.value.catalog, messages: remapped.value.notices };
};

export const loadConfig = (
  environment: Record<string, string | undefined>,
  effects: ConfigEffects = defaultEffects,
): ConfigLoad => {
  const path = configPathOf(environment);

  if (path === undefined) {
    return { catalog, messages: [] };
  }

  const read = effects.readFile(path);

  if (read.kind === 'missing') {
    return { catalog, messages: [] };
  }

  if (read.kind === 'failed') {
    return defaultsWith(`${path}: The file cannot be read (${read.reason}).`);
  }

  return loadText(read.text, path);
};
