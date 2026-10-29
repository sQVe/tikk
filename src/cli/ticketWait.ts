import type { Fact } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { appendFailure } from './factAppendFailure.ts';
import { conflict, refuseFileErrors, withLockedTicket } from './instructionLock.ts';
import { resolveMachine } from './ticketStatus.ts';
import { showOutput } from './ticketView.ts';

const waitUsage = 'Usage: tikk wait <id> [--text <what the user should do> | --done] [--json]';

const requireDraftPlan = (ticket: CliTicket): Result<undefined, CliFailure> => {
  if (ticket.frontMatter.kind !== 'plan') {
    return invalidArguments(
      `Ticket ${ticket.id} is not a plan: its kind is ${ticket.frontMatter.kind}, and only a draft plan can wait.`,
    );
  }

  if (ticket.frontMatter.status !== 'draft') {
    return conflict(`Plan ${ticket.id} is ${ticket.frontMatter.status}, not a draft.`);
  }

  return { ok: true, value: undefined };
};

const appendWaiting = async (
  input: CommandInput,
  ticket: CliTicket,
  waiting: boolean,
  text: string | undefined,
): Promise<CommandResult> => {
  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  const fact: Fact = {
    version: 1,
    kind: 'waiting',
    ticket: ticket.id,
    at: input.effects.now().toISOString(),
    machine: machine.value,
    waiting,
    ...(text === undefined ? {} : { text }),
  };

  const appended = await input.session.appendFact(machine.value, fact);

  if (!appended.ok) {
    return appendFailure(appended.reason);
  }

  return showOutput(input.session, input.effects.now(), ticket);
};

export const ticketWait = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {
    text: { type: 'string' },
    done: { type: 'boolean' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, ...extra] = parsed.value.positionals;

  if (rawId === undefined || extra.length > 0) {
    return invalidArguments(waitUsage);
  }

  const { values } = parsed.value;
  const done = values['done'] === true;
  const text = stringValue(values, 'text');

  if (done && text !== undefined) {
    return invalidArguments(`Give --text when a plan waits, not with --done. ${waitUsage}`);
  }

  return withLockedTicket(input, rawId, refuseFileErrors, async (ticket) => {
    const plan = requireDraftPlan(ticket);

    if (!plan.ok) {
      return plan;
    }

    return appendWaiting(input, ticket, !done, text);
  });
};
