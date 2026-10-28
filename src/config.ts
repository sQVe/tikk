import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { Result } from './result.ts';

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
  keys: Record<string, string[]>;
  icons: 'unicode' | 'nerdFont';
}

const configSchema = z.object({
  projects: z.record(z.string(), z.string()).optional(),
  machine: z.string().optional(),
  keys: z.record(z.string(), z.array(z.string())).optional(),
  icons: z.enum(['unicode', 'nerdFont']).optional(),
});

const defaultSettings: ConfigSettings = {
  projects: {},
  machine: undefined,
  keys: {},
  icons: 'unicode',
};

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

export const configPathOf = (homeDirectory: string): string =>
  join(homeDirectory, '.config', 'tikk', 'config.json');

const shapeMessageOf = (path: string): string =>
  `${path} must be {"projects": {"<owner>/<name>": "<project>"}, "machine": "<name>", "keys": {"<command id>": ["<key>"]}, "icons": "unicode" | "nerdFont"}.`;

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
      icons: parsed.data.icons ?? 'unicode',
    },
  };
};

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
