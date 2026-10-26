import { invalidArguments, stringValue } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { appendAndShow, readTarget, requireValue } from './instructionCommand.ts';
import { withLockedInstruction } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';

type LogType = 'progress' | 'question' | 'answer' | 'discovered';

const logTypes = new Set<string>(['progress', 'question', 'answer', 'discovered']);

const isLogType = (value: string): value is LogType => logTypes.has(value);

const logUsage =
  'Usage: tikk log <id> --type <progress|question|answer|discovered> --text <t> [--holder <h>] [--json]';

export const instructionLog = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    { type: { type: 'string' }, text: { type: 'string' }, holder: { type: 'string' } },
    logUsage,
  );

  if (!target.ok) {
    return target;
  }

  const { rawId, values } = target.value;
  const type = requireValue(values, 'type', logUsage);

  if (!type.ok) {
    return type;
  }

  if (!isLogType(type.value)) {
    return invalidArguments(`Log type "${type.value}" is not valid. ${logUsage}`);
  }

  const logType = type.value;
  const text = requireValue(values, 'text', logUsage);

  if (!text.ok) {
    return text;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const holder = stringValue(values, 'holder');

  return withLockedInstruction(input, rawId, 'allow', (locked) =>
    appendAndShow(input, locked, {
      version: 1,
      kind: 'log',
      ticket: locked.instruction.id,
      at: locked.now.toISOString(),
      machine: machine.value,
      type: logType,
      text: text.value,
      ...(holder === undefined ? {} : { holder }),
    }),
  );
};
