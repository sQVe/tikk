import { selectReady } from '../fact/fact.ts';
import type { Result } from '../result.ts';
import { invalidArguments, parseCommandArguments, stringValue } from './cliArguments.ts';
import type { CliFailure, CliTicket, CommandInput, CommandResult } from './cliEffects.ts';
import { problemLines, reconcileBeforeRead } from './prReconcile.ts';
import type { ReconcileProblem } from './prReconcile.ts';
import { findTicket, ticketView } from './ticketView.ts';

type Selection = ReturnType<typeof selectReady<CliTicket>>;
type ReadyKind = 'instruction' | 'slice';
type KindResult = Result<ReadyKind, CliFailure>;
type Skipped = Selection['skipped'][number];

const skippedView = (item: Skipped): Record<string, unknown> => ({
  id: item.ticket.id,
  title: item.ticket.frontMatter.title,
  reason: item.reason,
  ...(item.blockers === undefined ? {} : { blockers: item.blockers }),
  ...(item.holder === undefined ? {} : { holder: item.holder }),
  ...(item.leaseEnd === undefined ? {} : { leaseEnd: item.leaseEnd }),
});

const isUnreadable = (
  ticket: CliTicket,
  kind: ReadyKind,
  project?: string,
  parent?: string,
): boolean => {
  const { frontMatter } = ticket;

  if (ticket.error === null || frontMatter.kind !== kind || frontMatter.archived !== undefined) {
    return false;
  }

  const inProject = project === undefined || frontMatter.project === project;
  const inParent = parent === undefined || frontMatter.parent === parent;

  return inProject && inParent;
};

const parseErrorView = (ticket: CliTicket): Record<string, unknown> => ({
  id: ticket.id,
  title: ticket.frontMatter.title,
  reason: 'parseError',
  path: ticket.path,
});

const skippedDetails = (item: Skipped): string => {
  if (item.blockers !== undefined) {
    return item.blockers.map((blocker) => `${blocker.id} (${blocker.state})`).join(', ');
  }

  if (item.holder !== undefined) {
    return `${item.holder} until ${item.leaseEnd ?? ''}`;
  }

  return '';
};

const usage =
  'Usage: tikk ready [--project <p>] [--parent <id> | --kind <instruction|slice>] [--json]';

const chooseKind = (
  session: CommandInput['session'],
  parent: string | undefined,
  rawKind: string | undefined,
): KindResult => {
  if (parent !== undefined && rawKind !== undefined) {
    return invalidArguments('Use either --parent or --kind, not both.');
  }

  if (parent === undefined) {
    if (rawKind === undefined || rawKind === 'instruction' || rawKind === 'slice') {
      return { ok: true, value: rawKind ?? 'instruction' };
    }

    return invalidArguments(`Kind ${rawKind} is not instruction or slice.`);
  }

  const found = findTicket(session, parent);

  if (!found.ok) {
    return found;
  }

  const parentKind = found.value.frontMatter.kind;

  if (parentKind === 'plan') {
    return { ok: true, value: 'slice' };
  }

  if (parentKind === 'slice') {
    return { ok: true, value: 'instruction' };
  }

  return invalidArguments(`Ticket ${parent} is a ${parentKind}; --parent takes a plan or slice.`);
};

const readyText = (
  selection: Selection,
  unreadable: CliTicket[],
  problems: ReconcileProblem[],
): string => {
  const candidateLines = selection.candidates.map(
    ({ ticket, state }) => `${ticket.id}  ${state}  ${ticket.frontMatter.title}\n`,
  );

  const skippedLines = selection.skipped.map((item) => {
    const line = `skipped: ${item.ticket.id}  ${item.reason}  ${skippedDetails(item)}`;

    return `${line.trimEnd()}\n`;
  });

  const unreadableLines = unreadable.map(
    (ticket) => `skipped: ${ticket.id}  parseError  ${ticket.path}\n`,
  );

  return [...candidateLines, ...skippedLines, ...unreadableLines].join('') + problemLines(problems);
};

export const readyCommand = async ({
  args,
  effects,
  session,
}: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {
    project: { type: 'string' },
    parent: { type: 'string' },
    kind: { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.value.positionals.length > 0) {
    return invalidArguments(usage);
  }

  const reconciled = await reconcileBeforeRead({ effects, session });

  if (!reconciled.ok) {
    return reconciled;
  }

  const project = stringValue(parsed.value.values, 'project');
  const parent = stringValue(parsed.value.values, 'parent');
  const kind = chooseKind(session, parent, stringValue(parsed.value.values, 'kind'));

  if (!kind.ok) {
    return kind;
  }

  // Archived tickets stay in the list so a blocker that was archived is not reported as missing.
  const listed = session.listTickets({ includeArchived: true });

  // A ticket whose file does not parse cannot be claimed, so it is never a candidate.
  const unreadable = listed.filter((ticket) => isUnreadable(ticket, kind.value, project, parent));
  const tickets = listed.filter((ticket) => ticket.error === null);

  const facts = await session.listStateFacts();

  if (!facts.ok) {
    return { ok: false, reason: { code: 'storeError', message: facts.reason.message } };
  }

  const selection = selectReady(tickets, facts.value, effects.now(), {
    kind: kind.value,
    ...(project === undefined ? {} : { project }),
    ...(parent === undefined ? {} : { parent }),
  });

  const candidates = selection.candidates.map(({ ticket, state }) => ({
    ...ticketView(ticket, false),
    state,
  }));

  return {
    ok: true,
    value: {
      json: {
        candidates,
        skipped: [...selection.skipped.map(skippedView), ...unreadable.map(parseErrorView)],
        reconcileProblems: reconciled.value,
      },
      text: readyText(selection, unreadable, reconciled.value),
    },
  };
};
