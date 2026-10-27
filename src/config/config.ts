import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestKeymap } from '@opentui/keymap/testing';
import { z } from 'zod';

import type { Result } from '../result.ts';
import type { BindingTable } from '../tui/tui.tsx';
import { defaultBindings } from '../tui/tui.tsx';
import { remapBindings } from './remap.ts';
import type { ConfigKeys } from './remap.ts';

export type ConfigFileRead =
  | { kind: 'missing' }
  | { kind: 'text'; text: string }
  | { kind: 'failed' };

export interface ConfigEffects {
  readFile: (path: string) => ConfigFileRead;
}

export interface ConfigSettings {
  projects: Record<string, string>;
  machine: string | undefined;
  keys: ConfigKeys;
}

export interface ConfigLoad {
  bindings: BindingTable;
  messages: string[];
}

// Other top-level fields are ignored, so a file can hold settings this module does not read.
const configSchema = z.object({
  projects: z.record(z.string(), z.string()).optional(),
  machine: z.string().optional(),
  keys: z.record(z.string(), z.array(z.string())).optional(),
});

const defaultSettings: ConfigSettings = { projects: {}, machine: undefined, keys: {} };

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

      return { kind: 'failed' };
    }
  },
};

const configPathOf = (homeDirectory: string): string =>
  join(homeDirectory, '.config', 'tikk', 'config.json');

const shapeMessageOf = (path: string): string =>
  `${path} must be {"projects": {"<owner>/<name>": "<project>"}, "machine": "<name>", "keys": {"<command id>": ["<key>"]}}.`;

const parseSettings = (text: string, path: string): Result<ConfigSettings, string> => {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${path} is not valid JSON.` };
  }

  const parsed = configSchema.safeParse(json);

  if (!parsed.success) {
    return { ok: false, reason: shapeMessageOf(path) };
  }

  return {
    ok: true,
    value: {
      projects: parsed.data.projects ?? {},
      machine: parsed.data.machine,
      keys: parsed.data.keys ?? {},
    },
  };
};

// The one reader of the config file. A missing file means no settings.
export const readSettings = (
  homeDirectory: string,
  effects: ConfigEffects = defaultEffects,
): Result<ConfigSettings, string> => {
  const path = configPathOf(homeDirectory);
  const read = effects.readFile(path);

  if (read.kind === 'missing') {
    return { ok: true, value: defaultSettings };
  }

  if (read.kind === 'failed') {
    return { ok: false, reason: `Cannot read ${path}.` };
  }

  return parseSettings(read.text, path);
};

const defaultsWith = (message: string): ConfigLoad => ({
  bindings: defaultBindings,
  messages: [message],
});

const loadKeys = (keys: ConfigKeys, path: string): ConfigLoad => {
  const harness = createTestKeymap({ defaultKeys: true });
  const remapped = remapBindings(keys, path, harness.keymap);

  harness.cleanup();

  if (!remapped.ok) {
    return defaultsWith(remapped.reason);
  }

  return { bindings: remapped.value.bindings, messages: remapped.value.notices };
};

export const loadConfig = (
  homeDirectory: string,
  effects: ConfigEffects = defaultEffects,
): ConfigLoad => {
  const settings = readSettings(homeDirectory, effects);

  if (!settings.ok) {
    return defaultsWith(settings.reason);
  }

  return loadKeys(settings.value.keys, configPathOf(homeDirectory));
};
