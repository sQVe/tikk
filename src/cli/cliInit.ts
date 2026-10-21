import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliEffects, CommandResult } from './cliEffects.ts';

const usage = 'Usage: tikk init [--remote <url>] [--json]';

const createdVerb = (created: boolean): string => (created ? 'Created' : 'Found');

const initWithRemote = async (url: string, effects: CliEffects): Promise<CommandResult> => {
  const initialized = await effects.initRemoteStore(url);

  if (!initialized.ok) {
    return initialized;
  }

  const { store, created, remote } = initialized.value;

  return {
    ok: true,
    value: {
      json: { store, created, remote },
      text: `${createdVerb(created)} the store at ${store}, synced with ${remote}\n`,
    },
  };
};

export const cliInit = async (args: string[], effects: CliEffects): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, { remote: { type: 'string' } });

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments(usage);
  }

  const remote = stringValue(parsed.value.values, 'remote');

  if (remote === '') {
    return invalidArguments(`The remote URL must not be empty. ${usage}`);
  }

  if (remote !== undefined) {
    return initWithRemote(remote, effects);
  }

  const initialized = await effects.initStore();

  if (!initialized.ok) {
    return { ok: false, reason: { code: 'storeError', message: initialized.reason.message } };
  }

  const { store, created } = initialized.value;

  return {
    ok: true,
    value: {
      json: { store, created },
      text: `${createdVerb(created)} the store at ${store}\n`,
    },
  };
};
