import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { invariant } from '../invariant.ts';
import type { Result } from '../result.ts';
import type { CliEffects, CliFailure } from './cliEffects.ts';

export interface ParsedArguments {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export const parseCommandArguments = (
  args: string[],
  options: ParseArgsOptionsConfig,
): Result<ParsedArguments, CliFailure> => {
  try {
    const parsed = parseArgs({
      args,
      options: { json: { type: 'boolean' }, ...options },
      allowPositionals: true,
    });

    return { ok: true, value: { values: parsed.values, positionals: parsed.positionals } };
  } catch (error) {
    invariant(error instanceof Error, 'parseArgs threw a value that is not an Error.');

    return { ok: false, reason: { code: 'invalidArguments', message: error.message } };
  }
};

export const invalidArguments = (message: string): { ok: false; reason: CliFailure } => ({
  ok: false,
  reason: { code: 'invalidArguments', message },
});

export const stringValue = (
  values: ParsedArguments['values'],
  name: string,
): string | undefined => {
  const value = values[name];

  return typeof value === 'string' ? value : undefined;
};

export const listValue = (values: ParsedArguments['values'], name: string): string[] => {
  const value = values[name];

  return Array.isArray(value) ? value : [];
};

export const readBodyFile = async (
  effects: CliEffects,
  path: string,
): Promise<Result<string, CliFailure>> => {
  const text = await effects.readTextFile(path);

  if (text === undefined) {
    return invalidArguments(`Cannot read the body file ${path}.`);
  }

  return { ok: true, value: text };
};

export const forceOptions = {
  force: { type: 'boolean' },
  reason: { type: 'string' },
} as const;

// The reason an override gives for skipping a strict check, or undefined when no override is set.
export const readForce = (
  values: ParsedArguments['values'],
): Result<string | undefined, CliFailure> => {
  const force = values['force'] === true;
  const reason = stringValue(values, 'reason');

  if (!force && reason === undefined) {
    return { ok: true, value: undefined };
  }

  if (!force) {
    return invalidArguments('--reason works only with --force.');
  }

  if (reason === undefined || reason.trim() === '') {
    return invalidArguments('--force needs --reason <text> that says why.');
  }

  return { ok: true, value: reason };
};
