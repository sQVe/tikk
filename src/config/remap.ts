import { stringifyKeySequence } from '@opentui/keymap';
import type { createTestKeymap } from '@opentui/keymap/testing';

import type { Result } from '../result.ts';
import type { Command, CommandScope, OverlayScope } from '../tui/tui.tsx';
import { catalog, commandsOfLayer, readableKeyOf } from '../tui/tui.tsx';

export interface ConfigFile {
  keys: Record<string, string[]>;
}

type ConfigKeymap = ReturnType<typeof createTestKeymap>['keymap'];

export type Remapped = Result<{ catalog: readonly Command[]; notices: string[] }, string>;

// Default keys that a layer gave up, as JSON pairs of command id and key.
type Displaced = Map<CommandScope, Set<string>>;

interface Binding {
  command: Command;
  key: string;
  strokes: string[];
  user: boolean;
}

interface Layer {
  displaced: string[];
  notices: string[];
}

interface Resolution {
  displaced: Displaced;
  notices: string[];
}

const ctrlC = 'ctrl+c';
const overlayScopes: readonly OverlayScope[] = ['help', 'messages'];

const strokesOf = (keymap: ConfigKeymap, key: string): string[] | undefined => {
  try {
    return keymap.parseKeySequence(key).map((part) => stringifyKeySequence([part]));
  } catch {
    return undefined;
  }
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
  keymap: ConfigKeymap,
  path: string,
): string | undefined => {
  const strokes = strokesOf(keymap, key);

  if (strokes === undefined || strokes.length === 0) {
    return `${path}: keys.${id} "${key}" is not a key the keymap can read.`;
  }

  if (usesCtrlC(strokes) && !isWholeQuitKey(id, key)) {
    return `${path}: keys.${id} "${key}" uses Ctrl+C. Only quit may use Ctrl+C, and only as the whole key.`;
  }

  return undefined;
};

const checkEntries = (file: ConfigFile, keymap: ConfigKeymap, path: string): string | undefined => {
  for (const [id, keys] of Object.entries(file.keys)) {
    if (!catalog.some((command) => command.id === id)) {
      return `${path}: keys.${id} is not a command id. Command ids: ${commandIdsText()}.`;
    }

    for (const key of keys) {
      const problem = checkEntry(id, key, keymap, path);

      if (problem !== undefined) {
        return problem;
      }
    }
  }

  return undefined;
};

const configuredKeysOf = (command: Command, file: ConfigFile): string[] => {
  const configured = file.keys[command.id];

  if (configured === undefined) {
    return [...command.keys];
  }

  return command.id === 'quit' ? [...new Set([...configured, ctrlC])] : [...configured];
};

const displacedKeyOf = (id: string, key: string): string => JSON.stringify([id, key]);

const isDisplaced = (
  displaced: Displaced,
  scope: CommandScope,
  command: Command,
  key: string,
): boolean => displaced.get(scope)?.has(displacedKeyOf(command.id, key)) === true;

const keysInScope = (
  command: Command,
  file: ConfigFile,
  displaced: Displaced,
  scope: CommandScope,
): string[] =>
  configuredKeysOf(command, file).filter((key) => !isDisplaced(displaced, scope, command, key));

// A command the config names leaves a pending sequence with its remapped keys, so a remapped
// close key also works after g.
const sequenceKeysOf = (
  command: Command,
  file: ConfigFile,
  keys: readonly string[],
): readonly string[] | undefined => {
  if (command.keysDuringSequence === undefined) {
    return undefined;
  }

  if (file.keys[command.id] !== undefined) {
    return keys;
  }

  return command.keysDuringSequence.filter((key) => keys.includes(key));
};

const overlayKeysOf = (
  command: Command,
  file: ConfigFile,
  displaced: Displaced,
): Partial<Record<OverlayScope, readonly string[]>> => {
  const overlayKeys: Partial<Record<OverlayScope, readonly string[]>> = {};

  for (const scope of overlayScopes) {
    overlayKeys[scope] = keysInScope(command, file, displaced, scope);
  }

  return overlayKeys;
};

const projectedOf = (command: Command, file: ConfigFile, displaced: Displaced): Command => {
  const keys = keysInScope(command, file, displaced, command.scope);
  const projected: Command = { ...command, keys };
  const sequenceKeys = sequenceKeysOf(command, file, keys);

  if (sequenceKeys !== undefined) {
    projected.keysDuringSequence = sequenceKeys;
  }

  if (command.overlayMove !== undefined) {
    projected.overlayKeys = overlayKeysOf(command, file, displaced);
  }

  return projected;
};

const projectedCatalogOf = (file: ConfigFile, displaced: Displaced): readonly Command[] =>
  catalog.map((command) => projectedOf(command, file, displaced));

const scopesOf = (): CommandScope[] => [...new Set(catalog.map((command) => command.scope))];

const layerBindingsOf = (scope: CommandScope, file: ConfigFile, keymap: ConfigKeymap): Binding[] =>
  commandsOfLayer(catalog, scope).flatMap((command) =>
    configuredKeysOf(command, file).map((key) => ({
      command,
      key,
      strokes: strokesOf(keymap, key) ?? [],
      user: (file.keys[command.id] ?? []).includes(key),
    })),
  );

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

// A user key that starts or equals a default key displaces that default in the same layer.
const resolveLayer = (
  scope: CommandScope,
  bindings: readonly Binding[],
  path: string,
): Result<Layer, string> => {
  const layer: Layer = { displaced: [], notices: [] };

  for (const [index, first] of bindings.entries()) {
    for (const second of bindings.slice(index + 1)) {
      if (!relatedStrokes(first.strokes, second.strokes)) {
        continue;
      }

      if (first.user && second.user) {
        return { ok: false, reason: clashMessage(first, second, scope, path) };
      }

      const [winner, loser] = first.user ? [first, second] : [second, first];

      if (winner.user) {
        layer.displaced.push(displacedKeyOf(loser.command.id, loser.key));
        layer.notices.push(noticeOf(winner, loser, scope));
      }
    }
  }

  return { ok: true, value: layer };
};

const resolveAll = (
  file: ConfigFile,
  keymap: ConfigKeymap,
  path: string,
): Result<Resolution, string> => {
  const displaced: Displaced = new Map();
  const notices: string[] = [];

  for (const scope of scopesOf()) {
    const layer = resolveLayer(scope, layerBindingsOf(scope, file, keymap), path);

    if (!layer.ok) {
      return { ok: false, reason: layer.reason };
    }

    displaced.set(scope, new Set(layer.value.displaced));
    notices.push(...layer.value.notices);
  }

  return { ok: true, value: { displaced, notices: [...new Set(notices)] } };
};

export const remapCatalog = (file: ConfigFile, path: string, keymap: ConfigKeymap): Remapped => {
  const problem = checkEntries(file, keymap, path);

  if (problem !== undefined) {
    return { ok: false, reason: problem };
  }

  const resolved = resolveAll(file, keymap, path);

  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const projected = projectedCatalogOf(file, resolved.value.displaced);

  return { ok: true, value: { catalog: projected, notices: resolved.value.notices } };
};
