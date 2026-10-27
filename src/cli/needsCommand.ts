import { selectNeeds } from '../fact/fact.ts';
import type { NeedDetail, NeedItem } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import type { TicketId } from '../ticket/ticket.ts';
import { invalidArguments, parseCommandArguments } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { problemLines, reconcileBeforeRead } from './prReconcile.ts';
import type { ReconcileProblem } from './prReconcile.ts';

interface NeedViewBase {
  id: TicketId;
  title: string;
  since: string | null;
  ageSeconds: number | null;
  parseError?: string;
}

export type NeedView = NeedViewBase & NeedDetail;

export interface NeedsReading {
  items: NeedView[];
  reconcileProblems: ReconcileProblem[];
}

const secondsPerMinute = 60;
const secondsPerHour = 3600;
const secondsPerDay = 86_400;

const shortAge = (ageSeconds: number | null): string => {
  if (ageSeconds === null) {
    return '-';
  }

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

// The JSON key order follows the order of the fields in each item from the fact module.
const itemView = (item: NeedItem<CliTicket>): NeedView => {
  const { ticket, ...detail } = item;
  const parseError = ticket.error === null ? {} : { parseError: ticket.path };

  return { id: ticket.id, title: ticket.frontMatter.title, ...detail, ...parseError };
};

export const itemSubject = (view: NeedView): string => {
  if (view.reason === 'blockedFinding') {
    return `${view.fingerprint}  ${view.claim}`;
  }

  return view.reason === 'question' ? view.text : view.title;
};

// A question can span lines, and the text output keeps one line per item.
const lineBreaks = /\s*[\r\n\u2028\u2029]+\s*/g;

const openWorkOf = (view: Extract<NeedView, { reason: 'flagged' }>): TicketId[] => [
  ...view.openInstructions,
  ...view.openTasks,
];

const linkedIdsOf = (view: NeedView): TicketId[] => {
  if (view.reason === 'flagged') {
    return openWorkOf(view);
  }

  return view.reason === 'blockingTask' ? view.blocks : [];
};

const itemIdOf = (view: NeedView): string =>
  view.reason === 'question' || view.reason === 'submitted' ? `  ${view.item}` : '';

const textOf = (view: NeedView): string =>
  view.reason === 'draftPlan' && view.text !== undefined ? `  ${view.text}` : '';

const itemLine = (view: NeedView): string => {
  const age = shortAge(view.ageSeconds);
  const line = `${view.id}  ${view.reason}  ${age}${itemIdOf(view)}  ${itemSubject(view).replaceAll(lineBreaks, ' ')}${textOf(view)}`;
  const linkedIds = linkedIdsOf(view);
  const linked = linkedIds.length === 0 ? '' : `  ${linkedIds.join(' ')}`;
  const suffix = view.parseError === undefined ? '' : `  parseError ${view.parseError}`;

  return `${line}${linked}${suffix}\n`;
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
