import { parseCommandArguments } from './cliArguments.ts';
import type { CliEffects, CommandResult } from './cliEffects.ts';

export const cliInit = async (args: string[], effects: CliEffects): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const initialized = await effects.initStore();

  if (!initialized.ok) {
    return { ok: false, reason: { code: 'storeError', message: initialized.reason.message } };
  }

  const { store, created } = initialized.value;
  const verb = created ? 'Created' : 'Found';

  return {
    ok: true,
    value: { json: { store, created }, text: `${verb} the store at ${store}\n` },
  };
};
