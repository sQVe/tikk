import { selectNeeds } from '../fact/fact.ts';
import type { NeedItem } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { problemLines, reconcileBeforeRead } from './prReconcile.ts';
import type { ReconcileProblem } from './prReconcile.ts';

export interface NeedView {
  id: TicketId;
  title: string;
  reason: NeedItem<CliTicket>['reason'];
  since: string;
  ageSeconds: number;
  holder?: string;
  openTasks?: TicketId[];
  fingerprint?: string;
  claim?: string;
  parseError?: string;
}

export interface NeedsReading {
  items: NeedView[];
  reconcileProblems: ReconcileProblem[];
}

const secondsPerMinute = 60;
const secondsPerHour = 3600;
const secondsPerDay = 86_400;

const shortAge = (ageSeconds: number): string => {
  if (ageSeconds < secondsPerMinute) {
    return `${ageSeconds}s`;
  }

  if (ageSeconds < secondsPerHour) {
    return `${Math.floor(ageSeconds / secondsPerMinute)}m`;
  }

  if (ageSeconds < secondsPerDay) {
    return `${Math.floor(ageSeconds / secondsPerHour)}h`;
  }

  return `${Math.floor(ageSeconds / secondsPerDay)}d`;
};

const reasonFields = (
  item: NeedItem<CliTicket>,
): Pick<NeedView, 'holder' | 'openTasks' | 'fingerprint' | 'claim'> => {
  if (item.reason === 'staleClaim') {
    return { holder: item.holder };
  }

  if (item.reason === 'flagged') {
    return { openTasks: item.openTasks };
  }

  if (item.reason === 'blockedFinding') {
    return { fingerprint: item.fingerprint, claim: item.claim };
  }

  return {};
};

const itemView = (item: NeedItem<CliTicket>): NeedView => ({
  id: item.ticket.id,
  title: item.ticket.frontMatter.title,
  reason: item.reason,
  since: item.since,
  ageSeconds: item.ageSeconds,
  ...reasonFields(item),
  ...(item.ticket.error === null ? {} : { parseError: item.ticket.path }),
});

const itemSubject = (view: NeedView): string => {
  if (view.fingerprint !== undefined && view.claim !== undefined) {
    return `${view.fingerprint}  ${view.claim}`;
  }

  return view.title;
};

const itemLine = (view: NeedView): string => {
  const line = `${view.id}  ${view.reason}  ${shortAge(view.ageSeconds)}  ${itemSubject(view)}`;
  const tasks = view.openTasks === undefined ? '' : `  ${view.openTasks.join(' ')}`;
  const suffix = view.parseError === undefined ? '' : `  parseError ${view.parseError}`;

  return `${line}${tasks}${suffix}\n`;
};

export const readNeeds = async (
  input: Pick<CommandInput, 'effects' | 'session'>,
): Promise<Result<NeedsReading, CliFailure>> => {
  const { effects, session } = input;
  const reconciled = await reconcileBeforeRead({ effects, session });

  if (!reconciled.ok) {
    return reconciled;
  }

  const tickets = session.listTickets({ includeArchived: true });
  const facts = await session.listFacts();

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  const items = selectNeeds(tickets, facts.value, effects.now());

  return { ok: true, value: { items: items.map(itemView), reconcileProblems: reconciled.value } };
};

export const needsCommand = async ({
  args,
  effects,
  session,
}: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {});

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments('Usage: tikk needs [--json]');
  }

  const reading = await readNeeds({ effects, session });

  if (!reading.ok) {
    return reading;
  }

  const { items, reconcileProblems } = reading.value;

  return {
    ok: true,
    value: {
      json: { items, reconcileProblems },
      text: items.map(itemLine).join('') + problemLines(reconcileProblems),
    },
  };
};
