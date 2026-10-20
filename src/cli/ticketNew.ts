import type { Result } from '../result.ts';
import {
  parseProjectName,
  parseTicketId,
  serializeTicketFile,
  ticketFrontMatterSchema,
} from '../ticket/ticket.ts';
import type { ProjectName, TicketFrontMatter } from '../ticket/ticket.ts';
import {
  invalidArguments,
  parseCommandArguments,
  readBodyFile,
  stringValue,
} from './cliArguments.ts';
import type { ParsedArguments } from './cliArguments.ts';
import type { CliEffects, CliFailure, CommandInput, CommandResult } from './cliEffects.ts';
import { showAfterRefresh, storeFailure } from './ticketView.ts';

const usage =
  'Usage: tikk new <task|issue> <title> [--project <p>] [--parent <id>] [--status <s>] [--body-file <f>] [--json]';

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

const buildFrontMatter = (
  values: ParsedArguments['values'],
  kind: string,
  title: string,
  project: ProjectName,
): Result<TicketFrontMatter, CliFailure> => {
  const rawParent = stringValue(values, 'parent');
  const parent = rawParent === undefined ? undefined : parseTicketId(rawParent);

  if (parent !== undefined && !parent.ok) {
    return invalidArguments(parent.reason.message);
  }

  const frontMatter = ticketFrontMatterSchema.safeParse({
    kind,
    title,
    project,
    parent: parent?.value,
    status: stringValue(values, 'status') ?? 'open',
  });

  if (!frontMatter.success) {
    return invalidArguments(frontMatter.error.issues.map((issue) => issue.message).join('\n'));
  }

  return { ok: true, value: frontMatter.data };
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

export const ticketNew = async ({
  args,
  effects,
  session,
}: CommandInput): Promise<CommandResult> => {
  const parsed = parseCommandArguments(args, {
    project: { type: 'string' },
    parent: { type: 'string' },
    status: { type: 'string' },
    'body-file': { type: 'string' },
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

  const frontMatter = buildFrontMatter(values, kind, title, project.value);

  if (!frontMatter.ok) {
    return frontMatter;
  }

  const body = await readBody(effects, values);

  if (!body.ok) {
    return body;
  }

  const text = serializeTicketFile({ frontMatter: frontMatter.value, body: body.value });
  const created = await session.createTicketFile(project.value, title, text);

  if (!created.ok) {
    return storeFailure(created.reason.message);
  }

  const shown = await showAfterRefresh(session, created.value.id);

  return shown;
};
