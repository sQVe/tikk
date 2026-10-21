import packageJson from '../../package.json' with { type: 'json' };
import { taskAccept, taskClaim, taskLog, taskRelease, taskSubmit } from './claimCommands.ts';
import type { CliEffects, CommandInput, CommandResult } from './cliEffects.ts';
import { cliInit } from './cliInit.ts';
import { needsCommand } from './needsCommand.ts';
import { readyCommand } from './readyCommand.ts';
import { ticketCancel } from './ticketCancel.ts';
import { ticketEdit } from './ticketEdit.ts';
import { ticketList } from './ticketList.ts';
import { ticketNew } from './ticketNew.ts';
import { ticketShow } from './ticketShow.ts';

export type { CliEffects, CliSession } from './cliEffects.ts';

export interface CliStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type SessionCommand = (input: CommandInput) => CommandResult | Promise<CommandResult>;

const sessionCommands = new Map<string, SessionCommand>([
  ['new', ticketNew],
  ['show', ticketShow],
  ['ls', ticketList],
  ['edit', ticketEdit],
  ['claim', taskClaim],
  ['release', taskRelease],
  ['log', taskLog],
  ['submit', taskSubmit],
  ['accept', taskAccept],
  ['cancel', ticketCancel],
  ['ready', readyCommand],
  ['needs', needsCommand],
]);

const usage =
  'Usage: tikk <init|new|show|ls|edit|claim|release|log|submit|accept|cancel|ready|needs> [arguments] [--json]';

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

  const run = sessionCommands.get(command);

  if (run === undefined) {
    return failure('invalidArguments', `Unknown command "${command}". ${usage}`);
  }

  const opened = await effects.openSession();

  if (!opened.ok) {
    return { ok: false, reason: opened.reason };
  }

  using session = opened.value;

  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
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
