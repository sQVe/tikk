import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Result } from '../result.ts';
import type { Store } from './storePaths.ts';

export interface StoreInitEffects {
  runGit: (args: string[]) => Promise<Result<string, StoreReason>>;
}

export interface StoreReason {
  message: string;
}

const isObject = (json: unknown): json is object => typeof json === 'object' && json !== null;

const hasSupportedVersion = (json: unknown): boolean =>
  isObject(json) && 'version' in json && json.version === 1;

const configFileName = 'tikk.json';

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const openStore = async (root: string): Promise<Result<Store, StoreReason>> => {
  const configPath = join(root, configFileName);
  let text: string;

  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        ok: false,
        reason: { message: `No tikk store at ${root}: ${configPath} is missing. Run "tikk init".` },
      };
    }

    return { ok: false, reason: { message: `Cannot read ${configPath}.` } };
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: { message: `${configPath} is not valid JSON.` } };
  }

  if (!hasSupportedVersion(json)) {
    return { ok: false, reason: { message: `${configPath} must be {"version": 1}.` } };
  }

  return { ok: true, value: { root } };
};

export const initStore = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<{ store: Store; created: boolean }, StoreReason>> => {
  const existing = await openStore(root);

  if (existing.ok) {
    return { ok: true, value: { store: existing.value, created: false } };
  }

  const configPath = join(root, configFileName);

  const configExists = await readFile(configPath).then(
    () => true,
    () => false,
  );

  if (configExists) {
    return existing;
  }

  await mkdir(root, { recursive: true });

  const git = await effects.runGit(['-C', root, 'init']);

  if (!git.ok) {
    return git;
  }

  await writeFile(configPath, `${JSON.stringify({ version: 1 })}\n`);

  return { ok: true, value: { store: { root }, created: true } };
};
