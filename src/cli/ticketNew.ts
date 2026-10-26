import type { Result } from '../result.ts';
import {
  parseProjectName,
  parseTicketId,
  serializeTicketFile,
  ticketFrontMatterSchema,
} from '../ticket/ticket.ts';
import type { ProjectName, TicketFrontMatter, TicketId } from '../ticket/ticket.ts';
import {
  invalidArguments,
  listValue,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type {
  CliEffects,
  CliFailure,
  CliSession,
  CommandInput,
  CommandResult,
} from './cliEffects.ts';
import { withStoreLock } from './instructionLock.ts';
import { readCriteriaFile } from './ticketCriteria.ts';
import { checkSessionTree } from './ticketStatus.ts';
import { showAfterRefresh, storeFailure } from './ticketView.ts';

interface FrontMatterInput {
  values: ParsedArguments['values'];
  kind: string;
  title: string;
  project: ProjectName;
  criteria: unknown;
}

interface Edges {
  blockedBy: TicketId[];
  discoveredFrom: TicketId[];
  related: TicketId[];
}

const usage =
  'Usage: tikk new <plan|slice|instruction|issue> <title> [--project <p>] [--parent <id>] [--status <s>] [--rank <n>] [--blocked-by <id>]... [--discovered-from <id>]... [--related <id>]... [--covers <criterion>]... [--criteria-file <f>] [--body-file <f>] [--json]';

const chooseProject = async (
  effects: CliEffects,
  requested: string | undefined,
): Promise<{ ok: true; value: ProjectName } | { ok: false; reason: CliFailure }> => {
  if (requested === undefined) {
    const resolved = await effects.resolveProject();

    if (!resolved.ok) {
      return { ok: false, reason: { code: 'invalidArguments', message: resolved.reason.message } };
    }

    return resolved;
  }

  const parsed = parseProjectName(requested);

  if (!parsed.ok) {
    return invalidArguments(parsed.reason.message);
  }

  return parsed;
};

const parseIdList = (
  values: ParsedArguments['values'],
  name: string,
): Result<TicketId[], CliFailure> => {
  const ids: TicketId[] = [];

  for (const raw of listValue(values, name)) {
    const parsed = parseTicketId(raw);

    if (!parsed.ok) {
      return invalidArguments(`--${name}: ${parsed.reason.message}`);
    }

    ids.push(parsed.value);
  }

  return { ok: true, value: ids };
};

const parseEdges = (values: ParsedArguments['values']): Result<Edges, CliFailure> => {
  const blockedBy = parseIdList(values, 'blocked-by');

  if (!blockedBy.ok) {
    return blockedBy;
  }

  const discoveredFrom = parseIdList(values, 'discovered-from');

  if (!discoveredFrom.ok) {
    return discoveredFrom;
  }

  const related = parseIdList(values, 'related');

  if (!related.ok) {
    return related;
  }

  return {
    ok: true,
    value: {
      blockedBy: blockedBy.value,
      discoveredFrom: discoveredFrom.value,
      related: related.value,
    },
  };
};

const parseRank = (values: ParsedArguments['values']): Result<number | undefined, CliFailure> => {
  const raw = stringValue(values, 'rank');

  if (raw === undefined) {
    return { ok: true, value: undefined };
  }

  const rank = raw.trim() === '' ? Number.NaN : Number(raw);

  if (!Number.isFinite(rank)) {
    return invalidArguments(`The rank ${raw} is not a number.`);
  }

  return { ok: true, value: rank };
};

const buildFrontMatter = (input: FrontMatterInput): Result<TicketFrontMatter, CliFailure> => {
  const { values, kind, title, project, criteria } = input;
  const rawParent = stringValue(values, 'parent');
  const parent = rawParent === undefined ? undefined : parseTicketId(rawParent);

  if (parent !== undefined && !parent.ok) {
    return invalidArguments(parent.reason.message);
  }

  const rank = parseRank(values);

  if (!rank.ok) {
    return rank;
  }

  const edges = parseEdges(values);

  if (!edges.ok) {
    return edges;
  }

  const covers = listValue(values, 'covers');

  const frontMatter = ticketFrontMatterSchema.safeParse({
    kind,
    title,
    project,
    parent: parent?.value,
    rank: rank.value,
    ...edges.value,
    criteria,
    covers: covers.length === 0 ? undefined : covers,
    status: stringValue(values, 'status') ?? 'open',
  });

  if (!frontMatter.success) {
    return invalidArguments(frontMatter.error.issues.map((issue) => issue.message).join('\n'));
  }

  return { ok: true, value: frontMatter.data };
};

const checkTree = async (
  session: CliSession,
  frontMatter: TicketFrontMatter,
): Promise<Result<undefined, CliFailure>> => {
  const refreshed = await session.refresh();

  if (!refreshed.ok) {
    return { ok: false, reason: { code: 'storeError', message: refreshed.reason.message } };
  }

  return checkSessionTree(session, frontMatter);
};

const readBody = (
  effects: CliEffects,
  values: ParsedArguments['values'],
): Promise<Result<string, CliFailure>> => {
  const bodyPath = stringValue(values, 'body-file');

  if (bodyPath === undefined) {
    return Promise.resolve({ ok: true, value: '' });
  }

  return readBodyFile(effects, bodyPath);
};

export const ticketNew = async (input: CommandInput): Promise<CommandResult> => {
  const { args, effects, session } = input;

  const parsed = parseCommandArguments(args, {
    project: { type: 'string' },
    parent: { type: 'string' },
    status: { type: 'string' },
    'body-file': { type: 'string' },
    rank: { type: 'string' },
    'blocked-by': { type: 'string', multiple: true },
    'discovered-from': { type: 'string', multiple: true },
    related: { type: 'string', multiple: true },
    covers: { type: 'string', multiple: true },
    'criteria-file': { type: 'string' },
  });

  if (!parsed.ok) {
    return parsed;
  }

  const [kind, title, ...extra] = parsed.value.positionals;

  if (kind === undefined || title === undefined || extra.length > 0) {
    return invalidArguments(usage);
  }

  const { values } = parsed.value;
  const project = await chooseProject(effects, stringValue(values, 'project'));

  if (!project.ok) {
    return project;
  }

  const criteria = await readCriteriaFile(effects, stringValue(values, 'criteria-file'));

  if (!criteria.ok) {
    return criteria;
  }

  const frontMatter = buildFrontMatter({
    values,
    kind,
    title,
    project: project.value,
    criteria: criteria.value,
  });

  if (!frontMatter.ok) {
    return frontMatter;
  }

  const body = await readBody(effects, values);

  if (!body.ok) {
    return body;
  }

  const text = serializeTicketFile({ frontMatter: frontMatter.value, body: body.value });

  return withStoreLock(input, async () => {
    const checked = await checkTree(session, frontMatter.value);

    if (!checked.ok) {
      return checked;
    }

    const created = await session.createTicketFile(project.value, title, text);

    if (!created.ok) {
      return storeFailure(created.reason.message);
    }

    return showAfterRefresh(session, input.effects.now(), created.value.id);
  });
};
