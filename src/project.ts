import { join } from 'node:path';

import { z } from 'zod';

import type { Result } from './result.ts';
import { parseProjectName } from './ticket/ticket.ts';
import type { ProjectName } from './ticket/ticket.ts';

export type GitOutcome =
  | { kind: 'output'; stdout: string }
  | { kind: 'failed' }
  | { kind: 'unavailable'; message: string };

export type ConfigRead = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'failed' };

export interface ProjectEffects {
  runGit: (args: string[]) => Promise<GitOutcome>;
  readConfigFile: (path: string) => Promise<ConfigRead>;
  homeDirectory: string;
}

export interface ProjectReason {
  message: string;
}

const configSchema = z.object({ projects: z.record(z.string(), z.string()) });

const personalProject = 'personal';

const repositoryPatterns = [
  /^[^@/\s]+@[^:/\s]+:(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(?<owner>[^/]+)\/(?<name>[^/]+?)(?:\.git)?\/?$/,
];

const parseRepository = (url: string): { owner: string; name: string } | undefined => {
  for (const pattern of repositoryPatterns) {
    const groups = pattern.exec(url.trim())?.groups;

    if (groups?.['owner'] !== undefined && groups['name'] !== undefined) {
      return { owner: groups['owner'], name: groups['name'] };
    }
  }

  return undefined;
};

const readMappings = async (
  effects: ProjectEffects,
): Promise<Result<Map<string, string>, ProjectReason>> => {
  const configPath = join(effects.homeDirectory, '.config', 'tikk', 'config.json');
  const read = await effects.readConfigFile(configPath);
  const mappings = new Map<string, string>();

  if (read.kind === 'missing') {
    return { ok: true, value: mappings };
  }

  if (read.kind === 'failed') {
    return { ok: false, reason: { message: `Cannot read ${configPath}.` } };
  }

  let json: unknown;

  try {
    json = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: { message: `${configPath} is not valid JSON.` } };
  }

  const parsed = configSchema.safeParse(json);

  if (!parsed.success) {
    return {
      ok: false,
      reason: { message: `${configPath} must be {"projects": {"<owner>/<name>": "<project>"}}.` },
    };
  }

  for (const [key, value] of Object.entries(parsed.data.projects)) {
    mappings.set(key.toLowerCase(), value);
  }

  return { ok: true, value: mappings };
};

const personalResult = (): Result<ProjectName, ProjectReason> => parseProjectName(personalProject);

export const resolveProject = async (
  cwd: string,
  effects: ProjectEffects,
): Promise<Result<ProjectName, ProjectReason>> => {
  const remote = await effects.runGit(['-C', cwd, 'remote', 'get-url', 'origin']);

  if (remote.kind === 'unavailable') {
    return { ok: false, reason: { message: `Cannot run git: ${remote.message}` } };
  }

  if (remote.kind === 'failed') {
    return personalResult();
  }

  const repository = parseRepository(remote.stdout);

  if (repository === undefined) {
    return personalResult();
  }

  const mappings = await readMappings(effects);

  if (!mappings.ok) {
    return mappings;
  }

  const mapped = mappings.value.get(`${repository.owner}/${repository.name}`.toLowerCase());
  const parsed = parseProjectName(mapped ?? repository.name.toLowerCase());

  if (parsed.ok) {
    return parsed;
  }

  return {
    ok: false,
    reason: {
      message: `Cannot use repository "${repository.owner}/${repository.name}" as a project name. Add a mapping to the "projects" config in ~/.config/tikk/config.json.`,
    },
  };
};
