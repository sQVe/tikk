import { join } from 'node:path';

import type { Result } from '../result.ts';
import { commitArguments } from './storeCommit.ts';
import type { Store } from './storePaths.ts';

export interface StoreOpenFunctions {
  readFile: (path: string) => Promise<string>;
}

export interface StoreInitEffects extends StoreOpenFunctions {
  mkdir: (directory: string) => Promise<void>;
  writeFile: (path: string, text: string) => Promise<void>;
  runGit: (args: string[]) => Promise<Result<string, StoreReason>>;
}

export interface StoreReason {
  message: string;
}

const isObject = (json: unknown): json is object => typeof json === 'object' && json !== null;

const hasSupportedVersion = (json: unknown): boolean =>
  isObject(json) && 'version' in json && json.version === 1;

const configFileName = 'tikk.json';
const attributesFileName = '.gitattributes';
const attributesText = 'facts/** merge=union\n';

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export const openStore = async (
  root: string,
  effects: StoreOpenFunctions,
): Promise<Result<Store, StoreReason>> => {
  const configPath = join(root, configFileName);
  let text: string;

  try {
    text = await effects.readFile(configPath);
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

const ensureAttributesFile = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<undefined, StoreReason>> => {
  const attributesPath = join(root, attributesFileName);

  try {
    await effects.readFile(attributesPath);

    return { ok: true, value: undefined };
  } catch (error) {
    if (!isMissingFile(error)) {
      return { ok: false, reason: { message: `Cannot read ${attributesPath}.` } };
    }
  }

  try {
    await effects.writeFile(attributesPath, attributesText);
  } catch {
    return { ok: false, reason: { message: `Cannot write ${attributesPath}.` } };
  }

  return { ok: true, value: undefined };
};

const ensureFirstCommit = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<undefined, StoreReason>> => {
  const head = await effects.runGit(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD']);

  if (head.ok) {
    return { ok: true, value: undefined };
  }

  const added = await effects.runGit(['-C', root, 'add', '--', configFileName, attributesFileName]);

  if (!added.ok) {
    return added;
  }

  const commitOptions = await commitArguments(effects.runGit, root);

  const committed = await effects.runGit([
    ...commitOptions,
    '-C',
    root,
    'commit',
    '--quiet',
    '-m',
    'Start the tikk store',
  ]);

  return committed.ok ? { ok: true, value: undefined } : committed;
};

// Sync pushes `main`, so an existing store on another branch is renamed.
const ensureMainBranch = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<undefined, StoreReason>> => {
  const current = await effects.runGit(['-C', root, 'symbolic-ref', '--short', 'HEAD']);

  if (current.ok && current.value.trim() === 'main') {
    return { ok: true, value: undefined };
  }

  const renamed = await effects.runGit(['-C', root, 'branch', '-m', 'main']);

  return renamed.ok ? { ok: true, value: undefined } : renamed;
};

// The union driver merges fact lines from two machines, so `facts/` never conflicts.
const ensureHistory = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<undefined, StoreReason>> => {
  const attributes = await ensureAttributesFile(root, effects);

  if (!attributes.ok) {
    return attributes;
  }

  return ensureFirstCommit(root, effects);
};

export const initStore = async (
  root: string,
  effects: StoreInitEffects,
): Promise<Result<{ store: Store; created: boolean }, StoreReason>> => {
  const existing = await openStore(root, effects);

  if (existing.ok) {
    const branch = await ensureMainBranch(root, effects);

    if (!branch.ok) {
      return branch;
    }

    const history = await ensureHistory(root, effects);

    return history.ok ? { ok: true, value: { store: existing.value, created: false } } : history;
  }

  const configPath = join(root, configFileName);

  const configMissing = await effects.readFile(configPath).then(
    () => false,
    (error: unknown) => isMissingFile(error),
  );

  if (!configMissing) {
    return existing;
  }

  try {
    await effects.mkdir(root);
  } catch {
    return { ok: false, reason: { message: `Cannot create the store folder ${root}.` } };
  }

  const git = await effects.runGit(['-C', root, 'init', '--quiet', '--initial-branch=main']);

  if (!git.ok) {
    return git;
  }

  try {
    await effects.writeFile(configPath, `${JSON.stringify({ version: 1 })}\n`);
  } catch {
    return { ok: false, reason: { message: `Cannot write ${configPath}.` } };
  }

  const history = await ensureHistory(root, effects);

  return history.ok ? { ok: true, value: { store: { root }, created: true } } : history;
};
