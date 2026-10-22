import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliEffects, CommandResult, SyncSummary } from './cliEffects.ts';

const syncText = (summary: SyncSummary): string => {
  const steps = [
    summary.committed ? 'committed' : 'nothing to commit',
    summary.fetched ? 'fetched' : 'not fetched',
    summary.merged ? 'merged' : 'not merged',
    summary.pushed ? 'pushed' : 'not pushed',
  ];

  const lines = [`Synced the store: ${steps.join(', ')}.`];

  if (summary.pending.length > 0) {
    lines.push(
      'These files were not committed. Each one does not parse or changed in the last two seconds. A later sync commits it once it is valid and unchanged:',
      ...summary.pending.map((path) => `pending: ${path}`),
    );
  }

  const unreached = !summary.fetched || !summary.pushed;

  if (!summary.remote) {
    lines.push('The store has no remote. Connect one with "tikk init --remote <url>".');
  } else if (unreached) {
    lines.push(
      'The remote was not reached or did not take the push. Your changes stay local until a later sync.',
    );
  }

  for (const alias of summary.aliases) {
    lines.push(`renamed: ${alias.from} is now ${alias.to} in ${alias.path}`);
  }

  return `${lines.join('\n')}\n`;
};

export const syncCommand = async (args: string[], effects: CliEffects): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, { background: { type: 'boolean' } });

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk sync [--json]');
  }

  if (parsed.value.values['background'] === true) {
    await effects.runBackgroundSync();

    return { ok: true, value: { json: {}, text: '' } };
  }

  const synced = await effects.syncStore();

  if (!synced.ok) {
    return synced;
  }

  return { ok: true, value: { json: synced.value, text: syncText(synced.value) } };
};
