import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliEffects, CommandResult, SyncSummary } from './cliEffects.ts';

const syncText = (summary: SyncSummary): string => {
  const steps = [
    summary.committed ? 'committed' : 'nothing to commit',
    summary.fetched ? 'fetched' : 'not fetched',
    summary.merged ? 'merged' : 'not merged',
    summary.pushed ? 'pushed' : 'not pushed',
  ];

  const pendingLines = summary.pending.map((path) => `pending: ${path}\n`);

  return `Synced the store: ${steps.join(', ')}.\n${pendingLines.join('')}`;
};

export const syncCommand = async (args: string[], effects: CliEffects): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk sync [--json]');
  }

  const synced = await effects.syncStore();

  if (!synced.ok) {
    return synced;
  }

  return { ok: true, value: { json: synced.value, text: syncText(synced.value) } };
};
