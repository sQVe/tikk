import packageJson from '../../package.json' with { type: 'json' };
import { checkCommand } from './checkCommand.ts';
import type { CliEffects, CommandInput, CommandResult } from './cliEffects.ts';
import { cliInit } from './cliInit.ts';
import { coverageCommand } from './coverageCommand.ts';
import { findingCommand } from './findingCommand.ts';
import { historyCommand } from './historyCommand.ts';
import { instructionClaim, instructionRelease } from './instructionClaim.ts';
import { instructionPassUp, instructionReject } from './instructionItem.ts';
import { instructionLog } from './instructionLog.ts';
import { instructionAccept, instructionSubmit } from './instructionSubmit.ts';
import { needsCommand } from './needsCommand.ts';
import { prCommand } from './prLink.ts';
import { reconcileCommand } from './prReconcile.ts';
import { qaCommand } from './qaCommand.ts';
import { readyCommand } from './readyCommand.ts';
import { reviewCommand } from './reviewCommand.ts';
import { refreshSession } from './sessionRefresh.ts';
import { sliceAudit } from './sliceAudit.ts';
import { syncCommand } from './syncCommand.ts';
import { ticketArchive, ticketUnarchive } from './ticketArchive.ts';
import { ticketBlock, ticketUnblock } from './ticketBlock.ts';
import { ticketCancel } from './ticketCancel.ts';
import { ticketDone } from './ticketDone.ts';
import { ticketEdit } from './ticketEdit.ts';
import { ticketList } from './ticketList.ts';
import { ticketMove } from './ticketMove.ts';
import { ticketNew } from './ticketNew.ts';
import { ticketRank } from './ticketRank.ts';
import { ticketShow } from './ticketShow.ts';
import { ticketWait } from './ticketWait.ts';

export type { CliEffects, CliFailure, CliSession } from './cliEffects.ts';
export { openNeedsSession } from './needsSession.ts';
export type { NeedsSession } from './needsSession.ts';
export type { TicketDetail } from './ticketDetail.ts';
export type { ProjectTree, TreeProject, TreeSlice, TreeStateName } from '../fact/fact.ts';
export { itemSubject } from './needsCommand.ts';
export type { NeedView, NeedsReading } from './needsCommand.ts';

export interface CliStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type SessionCommand = (input: CommandInput) => CommandResult | Promise<CommandResult>;

const sessionCommands = new Map<string, SessionCommand>([
  ['new', ticketNew],
  ['show', ticketShow],
  ['history', historyCommand],
  ['ls', ticketList],
  ['edit', ticketEdit],
  ['block', ticketBlock],
  ['unblock', ticketUnblock],
  ['move', ticketMove],
  ['rank', ticketRank],
  ['claim', instructionClaim],
  ['release', instructionRelease],
  ['log', instructionLog],
  ['submit', instructionSubmit],
  ['accept', instructionAccept],
  ['reject', instructionReject],
  ['pass-up', instructionPassUp],
  ['cancel', ticketCancel],
  ['done', ticketDone],
  ['wait', ticketWait],
  ['ready', readyCommand],
  ['needs', needsCommand],
  ['pr', prCommand],
  ['reconcile', reconcileCommand],
  ['audit', sliceAudit],
  ['archive', ticketArchive],
  ['unarchive', ticketUnarchive],
  ['check', checkCommand],
  ['review', reviewCommand],
  ['finding', findingCommand],
  ['coverage', coverageCommand],
  ['qa', qaCommand],
]);

const usage =
  'Usage: tikk <init|sync|new|show|history|ls|edit|block|unblock|move|rank|claim|release|log|submit|accept|reject|pass-up|cancel|done|wait|ready|needs|pr|reconcile|audit|archive|unarchive|check|review|finding|coverage|qa> [arguments] [--json]';

const failure = (code: 'invalidArguments', message: string): CommandResult => ({
  ok: false,
  reason: { code, message },
});

const runCommand = async (
  command: string,
  args: string[],
  effects: CliEffects,
  json: boolean,
): Promise<CommandResult> => {
  if (command === 'init') {
    return cliInit(args, effects);
  }

  if (command === 'sync') {
    return syncCommand(args, effects);
  }

  const run = sessionCommands.get(command);

  if (run === undefined) {
    return failure('invalidArguments', `Unknown command "${command}". ${usage}`);
  }

  const opened = await effects.openSession();

  if (!opened.ok) {
    return { ok: false, reason: opened.reason };
  }

  using session = opened.value;

  const refreshed = await refreshSession(effects, session);

  if (!refreshed.ok) {
    return refreshed;
  }

  return await run({ args, json, effects, session });
};

const render = (result: CommandResult, json: boolean, streams: CliStreams): number => {
  if (result.ok) {
    const output = json ? `${JSON.stringify(result.value.json)}\n` : result.value.text;

    if (output !== '') {
      streams.stdout(output);
    }

    return 0;
  }

  if (json) {
    streams.stdout(`${JSON.stringify({ error: result.reason })}\n`);
  } else {
    streams.stderr(`${result.reason.message}\n`);
  }

  return 1;
};

export const runCli = async (
  argv: string[],
  effects: CliEffects,
  streams: CliStreams,
): Promise<number> => {
  const [command, ...args] = argv;

  if (command === '--version') {
    streams.stdout(`${packageJson.version}\n`);

    return 0;
  }

  const json = args.includes('--json');

  if (command === undefined) {
    return render(failure('invalidArguments', usage), json, streams);
  }

  const result = await runCommand(command, args, effects, json);

  return render(result, json, streams);
};
