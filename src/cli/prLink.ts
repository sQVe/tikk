import { ghSignal, readPullRequest } from '../github.ts';
import type { PullRequestObservation, PullRequestRef } from '../github.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CommandInput, CommandResult } from './cliEffects.ts';
import { appendFailure } from './factAppendFailure.ts';
import { withLockedTicket } from './instructionLock.ts';
import { differsFromObservation, makePrFact } from './prGithub.ts';
import { resolveMachine } from './ticketStatus.ts';
import { findTicket, showAfterRefresh, storeFailure } from './ticketView.ts';

const linkUsage = 'Usage: tikk pr link <slice> <pr-url> [--json]';

const pullUrl = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)$/;

const parsePullUrl = (url: string): PullRequestRef | undefined => {
  const match = pullUrl.exec(url);

  if (match === null) {
    return undefined;
  }

  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]) };
};

const appendLink = async (
  input: CommandInput,
  link: { ticket: TicketId; ref: PullRequestRef; seen: PullRequestObservation; machine: string },
): Promise<CommandResult> => {
  const { ticket, ref, seen, machine } = link;
  const facts = await input.session.listStateFacts([ticket]);

  if (!facts.ok) {
    return storeFailure(facts.reason.message);
  }

  const known = facts.value
    .filter((fact) => fact.kind === 'pr')
    .findLast((fact) => fact.repository === ref.repository && fact.number === ref.number);

  const selected = facts.value.findLast((fact) => fact.kind === 'pr');

  const unchanged =
    known?.kind === 'pr' &&
    known === selected &&
    !differsFromObservation({ ...known, mergeCommit: known.mergeCommit ?? null }, seen);

  if (!unchanged) {
    const fact = makePrFact({ ticket, at: input.effects.now(), machine }, ref, seen);
    const appended = await input.session.appendFact(machine, fact);

    if (!appended.ok) {
      return appendFailure(appended.reason);
    }
  }

  return showAfterRefresh(input.session, input.effects.now(), ticket);
};

const prLink = async (input: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(input.args, {});

  if (!parsed.ok) {
    return parsed;
  }

  const [rawId, url, ...extra] = parsed.value.positionals;

  if (rawId === undefined || url === undefined || extra.length > 0) {
    return invalidArguments(linkUsage);
  }

  const ref = parsePullUrl(url);

  if (ref === undefined) {
    return invalidArguments(
      `"${url}" is not a pull request URL. Use https://github.com/<owner>/<name>/pull/<number>.`,
    );
  }

  const found = findTicket(input.session, rawId);

  if (!found.ok) {
    return found;
  }

  const slice = found.value;

  if (slice.frontMatter.kind !== 'slice') {
    return invalidArguments(
      `Ticket ${slice.id} is not a slice: its kind is ${slice.frontMatter.kind}.`,
    );
  }

  const seen = await readPullRequest(input.effects.runGh, ref, ghSignal());

  if (!seen.ok) {
    return { ok: false, reason: { code: 'ghError', message: seen.reason.message } };
  }

  const machine = await resolveMachine(input);

  if (!machine.ok) {
    return machine;
  }

  return withLockedTicket(
    input,
    rawId,
    { fileErrors: 'refuse', requireInstruction: false },
    (locked) =>
      appendLink(input, { ticket: locked.id, ref, seen: seen.value, machine: machine.value }),
  );
};

export const prCommand = (input: CommandInput): Promise<CommandResult> | CommandResult => {
  const [subcommand, ...args] = input.args;

  if (subcommand !== 'link') {
    return invalidArguments(linkUsage);
  }

  return prLink({ ...input, args });
};
