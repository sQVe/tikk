import type { Result } from '../result.ts';
import { invalidArguments } from './cliArguments.ts';
import type { CliEffects, CliFailure } from './cliEffects.ts';

// Reads the YAML list of a --criteria-file. The front matter schema checks each criterion.
export const readCriteriaFile = async (
  effects: CliEffects,
  path: string | undefined,
): Promise<Result<unknown, CliFailure>> => {
  if (path === undefined) {
    return { ok: true, value: undefined };
  }

  const text = await effects.readTextFile(path);

  if (text === undefined) {
    return invalidArguments(`Cannot read the criteria file ${path}.`);
  }

  let criteria: unknown;

  try {
    criteria = Bun.YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return invalidArguments(`The criteria file ${path} is not valid YAML: ${detail}`);
  }

  if (!Array.isArray(criteria)) {
    return invalidArguments(`The criteria file ${path} must hold a YAML list.`);
  }

  return { ok: true, value: criteria };
};
