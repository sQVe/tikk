import { stringifyKeySequence } from '@opentui/keymap';
import type { createTestKeymap } from '@opentui/keymap/testing';

import type { Result } from '../result.ts';
import type { Binding, BindingTable, Command, CommandScope, KeyChoice } from '../tui/tui.tsx';
import {
  catalog,
  commandScopes,
  emptyBindingTable,
  expandBindings,
  readableKeyOf,
} from '../tui/tui.tsx';

export type ConfigKeys = Record<string, string[]>;

type ConfigKeymap = ReturnType<typeof createTestKeymap>['keymap'];

type StrokesOf = (key: string) => readonly string[];

export type Remapped = Result<{ bindings: BindingTable; notices: string[] }, string>;

interface ScopeResolution {
  surviving: Binding[];
  notices: string[];
}

const ctrlC = 'ctrl+c';

// An unreadable key has no strokes, so no check treats it as a valid key.
const strokesIn = (keymap: ConfigKeymap, key: string): string[] => {
  try {
    return keymap.parseKeySequence(key).map((part) => stringifyKeySequence([part]));
  } catch {
    return [];
  }
};

const parsedStrokesOf = (keymap: ConfigKeymap): StrokesOf => {
  const cache = new Map<string, readonly string[]>();

  return (key) => {
    const cached = cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const strokes = strokesIn(keymap, key);

    cache.set(key, strokes);

    return strokes;
  };
};

const relatedStrokes = (first: readonly string[], second: readonly string[]): boolean => {
  const shared = Math.min(first.length, second.length);

  return first.slice(0, shared).join(' ') === second.slice(0, shared).join(' ');
};

const commandIdsText = (): string => [...new Set(catalog.map((command) => command.id))].join(', ');

const usesCtrlC = (strokes: readonly string[]): boolean =>
  strokes.some((stroke) => stroke.includes(ctrlC));

const isWholeQuitKey = (id: string, key: string): boolean => id === 'quit' && key === ctrlC;

const checkEntry = (
  id: string,
  key: string,
  strokesOf: StrokesOf,
  path: string,
): string | undefined => {
  const strokes = strokesOf(key);

  if (strokes.length === 0) {
    return `${path}: keys.${id} "${key}" is not a key the keymap can read.`;
  }

  if (usesCtrlC(strokes) && !isWholeQuitKey(id, key)) {
    return `${path}: keys.${id} "${key}" uses Ctrl+C. Only quit may use Ctrl+C, and only as the whole key.`;
  }

  return undefined;
};

const checkEntries = (keys: ConfigKeys, strokesOf: StrokesOf, path: string): string | undefined => {
  for (const [id, entries] of Object.entries(keys)) {
    if (!catalog.some((command) => command.id === id)) {
      return `${path}: keys.${id} is not a command id. Command ids: ${commandIdsText()}.`;
    }

    for (const key of entries) {
      const problem = checkEntry(id, key, strokesOf, path);

      if (problem !== undefined) {
        return problem;
      }
    }
  }

  return undefined;
};

// Quit always keeps Ctrl+C, so a remap of quit can never take it away.
const choicesOf = (keys: ConfigKeys, command: Command): KeyChoice[] => {
  const configured = keys[command.id];

  if (configured === undefined) {
    return command.keys.map((key) => ({ key, user: false }));
  }

  const uniqueKeys = [...new Set(configured)];
  const choices: KeyChoice[] = uniqueKeys.map((key) => ({ key, user: true }));

  if (command.id === 'quit' && !uniqueKeys.includes(ctrlC)) {
    choices.push({ key: ctrlC, user: false });
  }

  return choices;
};

const clashMessage = (
  first: Binding,
  second: Binding,
  scope: CommandScope,
  path: string,
): string => {
  const shownFirst = `keys.${first.command.id} "${first.key}"`;
  const shownSecond = `keys.${second.command.id} "${second.key}"`;

  return `${path}: ${shownFirst} and ${shownSecond} clash in the ${scope} layer. Give one of them another key.`;
};

const noticeOf = (winner: Binding, loser: Binding, scope: CommandScope): string =>
  `Key "${winner.key}" of ${winner.command.id} replaces the default "${readableKeyOf(loser.key)}" of ${loser.command.id} in the ${scope} layer.`;

// A user key that starts or equals a default key displaces that default in the same scope only.
const resolveScope = (
  scope: CommandScope,
  bindings: readonly Binding[],
  strokesOf: StrokesOf,
  path: string,
): Result<ScopeResolution, string> => {
  const displaced = new Set<Binding>();
  const notices: string[] = [];

  for (const [index, first] of bindings.entries()) {
    for (const second of bindings.slice(index + 1)) {
      if (!relatedStrokes(strokesOf(first.key), strokesOf(second.key))) {
        continue;
      }

      if (first.user && second.user) {
        return { ok: false, reason: clashMessage(first, second, scope, path) };
      }

      const [winner, loser] = first.user ? [first, second] : [second, first];

      if (winner.user) {
        displaced.add(loser);
        notices.push(noticeOf(winner, loser, scope));
      }
    }
  }

  return {
    ok: true,
    value: { surviving: bindings.filter((binding) => !displaced.has(binding)), notices },
  };
};

export const remapBindings = (keys: ConfigKeys, path: string, keymap: ConfigKeymap): Remapped => {
  const strokesOf = parsedStrokesOf(keymap);
  const problem = checkEntries(keys, strokesOf, path);

  if (problem !== undefined) {
    return { ok: false, reason: problem };
  }

  const expanded = expandBindings((command) => choicesOf(keys, command));
  const surviving = emptyBindingTable();
  const notices = new Set<string>();

  for (const scope of commandScopes) {
    const resolved = resolveScope(scope, expanded[scope], strokesOf, path);

    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    surviving[scope] = resolved.value.surviving;

    for (const notice of resolved.value.notices) {
      notices.add(notice);
    }
  }

  return { ok: true, value: { bindings: surviving, notices: [...notices] } };
};
