import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import type { Result } from '../result.ts';
import type { CliEffects, CliFailure } from './cliEffects.ts';

export interface ParsedArguments {
  values: Record<string, string | boolean | undefined>;
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
    const message = error instanceof Error ? error.message : 'Cannot read the arguments.';

    return { ok: false, reason: { code: 'invalidArguments', message } };
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
