import { selectOpenQuestions } from '../fact/fact.ts';
import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, stringValue } from './cliArguments.ts';
import type { CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import {
  appendAndShow,
  appendAndShowItem,
  listInstructionFacts,
  readTarget,
  requireValue,
} from './instructionCommand.ts';
import { conflict, withLockedInstruction } from './instructionLock.ts';
import type { LockedInstruction } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';

type LogType = 'progress' | 'question' | 'answer' | 'discovered';

interface LogEntry {
  machine: string;
  text: string;
  holder: string | undefined;
}

type LogKind = { type: 'answer'; item: string } | { type: Exclude<LogType, 'answer'> };

const logTypes = new Set<string>(['progress', 'question', 'answer', 'discovered']);

const isLogType = (value: string): value is LogType => logTypes.has(value);

const logUsage =
  'Usage: tikk log <id> --type <progress|question|answer|discovered> --text <t> [--item <question>] [--holder <h>] [--json]';

const entryFields = (locked: LockedInstruction, entry: LogEntry) => ({
  version: 1 as const,
  kind: 'log' as const,
  ticket: locked.instruction.id,
  at: locked.now.toISOString(),
  machine: entry.machine,
  text: entry.text,
  ...(entry.holder === undefined ? {} : { holder: entry.holder }),
});

const readLogKind = (logType: LogType, item: string | undefined): Result<LogKind, CliFailure> => {
  if (logType === 'answer') {
    return item === undefined
      ? invalidArguments(`Give --item with the question that the answer answers. ${logUsage}`)
      : { ok: true, value: { type: logType, item } };
  }

  if (item !== undefined) {
    return invalidArguments(`Only an answer takes --item. ${logUsage}`);
  }

  return { ok: true, value: { type: logType } };
};

const answerQuestion = async (
  input: CommandInput,
  locked: LockedInstruction,
  entry: LogEntry,
  item: string,
): Promise<CommandResult> => {
  const facts = await listInstructionFacts(input, locked);

  if (!facts.ok) {
    return facts;
  }

  const isOpen = selectOpenQuestions(facts.value).some((question) => question.item === item);

  if (!isOpen) {
    return conflict(`Item ${item} is not an open question on ${locked.instruction.id}.`);
  }

  return appendAndShow(input, locked, { ...entryFields(locked, entry), type: 'answer', item });
};

const appendLog = (
  input: CommandInput,
  locked: LockedInstruction,
  entry: LogEntry,
  logType: Exclude<LogType, 'answer'>,
): Promise<CommandResult> => {
  if (logType === 'question') {
    const question: Fact & { item: string } = {
      ...entryFields(locked, entry),
      type: 'question',
      item: input.effects.newItemId(),
    };

    return appendAndShowItem(input, locked, question);
  }

  return appendAndShow(input, locked, { ...entryFields(locked, entry), type: logType });
};

export const instructionLog = async (input: CommandInput): Promise<CommandResult> => {
  const target = readTarget(
    input.args,
    {
      type: { type: 'string' },
      text: { type: 'string' },
      item: { type: 'string' },
      holder: { type: 'string' },
    },
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

  const text = requireValue(values, 'text', logUsage);

  if (!text.ok) {
    return text;
  }

  const kind = readLogKind(type.value, stringValue(values, 'item'));

  if (!kind.ok) {
    return kind;
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const entry = { machine: machine.value, text: text.value, holder: stringValue(values, 'holder') };
  const logKind = kind.value;

  return withLockedInstruction(input, rawId, 'allow', (locked) =>
    logKind.type === 'answer'
      ? answerQuestion(input, locked, entry, logKind.item)
      : appendLog(input, locked, entry, logKind.type),
  );
};
